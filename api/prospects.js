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
    const serperRes = await fetch(SERPER_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'X-API-KEY': apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ q: searchQuery, num: 10 })
    });

    const data = await serperRes.json();

    if (!serperRes.ok) {
      const message = data?.message || data?.error || 'Serper API request failed.';
      res.statusCode = serperRes.status;
      return res.end(JSON.stringify({ error: message }));
    }

    // Serper's response shape: { organic: [ { title, link, snippet, position }, ... ] }
    const items = Array.isArray(data.organic) ? data.organic : [];

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
    return res.end(JSON.stringify({ prospects }));

  } catch (err) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: 'Failed to reach Serper API.', detail: err.message }));
  }
};