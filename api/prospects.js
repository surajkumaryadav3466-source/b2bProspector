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
 * This fetches the domain's own homepage and extracts a likely company name from
 * its <title> or og:site_name tag, so we can search LinkedIn for the name people
 * actually use, not the domain string.
 */
async function resolveCompanyName(domain) {
  const candidates = [`https://${domain}`, `https://www.${domain}`];

  for (const url of candidates) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
      clearTimeout(timeout);
      if (!res.ok) continue;

      const html = await res.text();

      // Prefer og:site_name (usually the clean brand name), fall back to <title>.
      const ogMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);
      const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);

      let raw = ogMatch?.[1] || titleMatch?.[1];
      if (!raw) continue;

      // Strip common trailing suffixes like "| Home", "- Official Site", "| Plumbing Services".
      const cleaned = raw
        .split(/\s*[\|\-–]\s*/)[0]
        .replace(/&amp;/g, '&')
        .trim();

      if (cleaned.length >= 2 && cleaned.length < 80) return cleaned;
    } catch (err) {
      continue; // try next candidate URL, or fall through to domain-only search
    }
  }

  return null;
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

    // If the domain-based query came up empty, try again using the company's
    // actual name (resolved from its homepage) — this is what most real LinkedIn
    // profiles will actually contain, unlike the raw domain string.
    let companyName = null;
    if (items.length === 0) {
      companyName = await resolveCompanyName(domain);
      if (companyName) {
        const nameQuery = `site:linkedin.com/in/ "at ${companyName}"`;
        items = await searchLinkedIn(apiKey, nameQuery);
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
    return res.end(JSON.stringify({ prospects, resolvedCompanyName: companyName || undefined }));

  } catch (err) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: 'Failed to reach Serper API.', detail: err.message }));
  }
};