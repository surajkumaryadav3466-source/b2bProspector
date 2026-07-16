/**
 * GET /api/prospects?domain=example.com
 *
 * Queries the Serper.dev Google Search API for public LinkedIn profile pages
 * mentioning the target domain, then parses the result titles into
 * { name, title, linkedinUrl } objects.
 *
 * Requires env var: SERPER_API_KEY
 * Free tier: 2,500 searches total (one-time, not monthly). This endpoint uses
 * exactly 1 search per call. See README.md for signup steps.
 *
 * NOTE: this replaces the original Google Custom Search JSON API integration —
 * that API is now closed to new Google Cloud projects/customers (confirmed via
 * Google's own docs as of 2026), so it no longer works for newly created keys.
 * Serper still queries live Google results under the hood, so the same
 * site:linkedin.com/in/ query pattern and result-title parsing below work
 * unchanged — only the request/auth layer is different.
 */

const SERPER_SEARCH_ENDPOINT = 'https://google.serper.dev/search';

/**
 * Google result titles for LinkedIn profiles are typically formatted as one of:
 *   "John Doe - Software Engineer - Stripe | LinkedIn"
 *   "John Doe - Software Engineer at Stripe | LinkedIn"
 *   "John Doe | LinkedIn"
 * This function splits on those separators and cleans up the pieces.
 */
function parseLinkedInTitle(rawTitle) {
  if (!rawTitle) return null;

  // Strip the trailing "| LinkedIn" (or similar suffixes) first.
  let cleaned = rawTitle.replace(/\s*\|\s*LinkedIn.*$/i, '').trim();

  // Split on " - " (most common separator Google uses for these listings).
  const dashParts = cleaned.split(/\s+-\s+/).map(p => p.trim()).filter(Boolean);

  let name = null;
  let title = null;

  if (dashParts.length >= 2) {
    name = dashParts[0];
    // Everything after the first dash is the title/role (may itself contain " - Company").
    const rest = dashParts.slice(1).join(' - ');
    // Handle "Title at Company" vs "Title - Company"
    const atMatch = rest.match(/^(.*?)\s+at\s+(.+)$/i);
    title = atMatch ? atMatch[1].trim() : rest;
  } else {
    // Fallback: try "Name at Company" or "Name, Title" patterns, else just use the name.
    const atMatch = cleaned.match(/^(.*?)\s+at\s+(.+)$/i);
    if (atMatch) {
      name = atMatch[1].trim();
      title = null;
    } else {
      name = cleaned;
    }
  }

  if (!name) return null;

  // Basic sanity filter: names shouldn't contain digits or be empty after cleanup.
  if (/\d/.test(name) || name.length < 2) return null;

  return { name, title: title || null };
}

function extractLinkedInUrl(item) {
  if (item.link && item.link.includes('linkedin.com/in/')) return item.link;
  return null;
}

/**
 * People almost never write a company's raw domain ("mrrooter.com") on LinkedIn —
 * they write the company's actual name ("Mr. Rooter Plumbing"). Searching for the
 * domain string alone works by coincidence for brand-name-matches-domain companies
 * (Stripe/stripe.com) but silently returns nothing for most real businesses.
 *
 * This fetches the domain's own homepage and extracts likely company name
 * candidates from its <title> and og:site_name tag. Different sites order their
 * title tag differently ("Brand | Tagline" vs "Tagline | Brand"), so this returns
 * BOTH the first and last segment as candidates rather than guessing one.
 *
 * Also attempts to extract a city/region from the page (via JSON-LD address
 * schema or a "City, ST" text pattern), which helps disambiguate multi-location
 * franchise businesses (e.g. "Mr. Rooter Plumbing" has hundreds of independently
 * owned regional franchises — searching the brand name alone mixes all of them
 * together with no way to tell which one the target domain actually is).
 */
async function resolveCompanyInfo(domain) {
  const candidateUrls = [`https://${domain}`, `https://www.${domain}`];

  for (const url of candidateUrls) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      clearTimeout(timeout);
      if (!res.ok) continue;

      const html = await res.text();

      const ogMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
      const raw = ogMatch?.[1] || titleMatch?.[1];
      if (!raw) continue;

      const clean = s => s.replace(/&amp;/g, '&').trim();
      const segments = raw.split(/\s*[\|\-–]\s*/).map(clean).filter(s => s.length >= 2 && s.length < 80);

      // og:site_name is usually already clean and unambiguous — trust it alone if present.
      // Otherwise offer both the first and last title segment as candidates, since brand
      // name placement varies by site ("Brand | Tagline" vs "Tagline | Brand").
      const nameCandidates = ogMatch
        ? [clean(ogMatch[1])]
        : [...new Set([segments[0], segments[segments.length - 1]])].filter(Boolean);

      // Try to find a city/region for franchise disambiguation.
      let city = null;
      const jsonLdMatch = html.match(/"addressLocality"\s*:\s*"([^"]+)"/i);
      if (jsonLdMatch) {
        city = clean(jsonLdMatch[1]);
      } else {
        // Fallback: look for a "City, ST" pattern (common in footers/contact sections).
        const cityStateMatch = html.match(/\b([A-Z][a-zA-Z.\s]{2,25}),\s*([A-Z]{2})\b/);
        if (cityStateMatch) city = cityStateMatch[1].trim();
      }

      return { nameCandidates, city };
    } catch (err) {
      continue; // try next candidate URL
    }
  }

  return { nameCandidates: [], city: null };
}

async function searchLinkedIn(apiKey, query) {
  const res = await fetch(SERPER_SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ q: query, num: 10 })
  });
  const data = await res.json();
  if (!res.ok) {
    const message = data?.message || data?.error || 'Serper API request failed.';
    throw new Error(message);
  }
  return Array.isArray(data.organic) ? data.organic : [];
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const domain = (req.query.domain || '').toString().trim().toLowerCase();
  if (!domain) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Missing required query parameter: domain' }));
  }

  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    res.statusCode = 500;
    return res.end(JSON.stringify({
      error: 'Server is missing the SERPER_API_KEY environment variable. See README.md setup steps.'
    }));
  }

  const searchQuery = `site:linkedin.com/in/ "at ${domain}"`;

  try {
    let items = await searchLinkedIn(apiKey, searchQuery);
    let resolvedCompanyName = null;
    let resolvedCity = null;

    if (items.length === 0) {
      const { nameCandidates, city } = await resolveCompanyInfo(domain);
      resolvedCity = city;

      for (const candidateName of nameCandidates) {
        // If we found a city (helps disambiguate franchises like "Mr. Rooter
        // Plumbing", which has hundreds of independently-owned local branches),
        // try the tighter name+city query first, then fall back to name-only.
        if (city) {
          const tightQuery = `site:linkedin.com/in/ "at ${candidateName}" "${city}"`;
          items = await searchLinkedIn(apiKey, tightQuery);
          if (items.length > 0) {
            resolvedCompanyName = candidateName;
            break;
          }
        }

        const nameQuery = `site:linkedin.com/in/ "at ${candidateName}"`;
        items = await searchLinkedIn(apiKey, nameQuery);
        if (items.length > 0) {
          resolvedCompanyName = candidateName;
          break;
        }
      }
    }

    const prospects = items
      .map(item => {
        const parsed = parseLinkedInTitle(item.title);
        if (!parsed) return null;
        const linkedinUrl = extractLinkedInUrl(item);
        return {
          name: parsed.name,
          title: parsed.title,
          linkedinUrl
        };
      })
      .filter(Boolean)
      // De-duplicate by name in case results contain near-identical listings.
      .filter((p, idx, arr) => arr.findIndex(x => x.name === p.name) === idx);

    res.statusCode = 200;
    return res.end(JSON.stringify({
      prospects,
      resolvedCompanyName: resolvedCompanyName || undefined,
      resolvedCity: resolvedCity || undefined
    }));

  } catch (err) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: 'Failed to reach Serper API.', detail: err.message }));
  }
};