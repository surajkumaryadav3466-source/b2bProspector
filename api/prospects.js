/**
 * GET /api/prospects?domain=example.com
 *
 * Queries the Google Custom Search JSON API for public LinkedIn profile pages
 * mentioning the target domain, then parses the result titles into
 * { name, title, linkedinUrl } objects.
 *
 * Requires env vars: GOOGLE_API_KEY, GOOGLE_CX
 * Free tier: 100 queries/day. This endpoint uses exactly 1 query per call.
 */

const GOOGLE_SEARCH_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

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

  const apiKey = process.env.GOOGLE_API_KEY;
  const cx = process.env.GOOGLE_CX;

  if (!apiKey || !cx) {
    res.statusCode = 500;
    return res.end(JSON.stringify({
      error: 'Server is missing GOOGLE_API_KEY / GOOGLE_CX environment variables. See README.md setup steps.'
    }));
  }

  const searchQuery = `site:linkedin.com/in/ "at ${domain}"`;

  const url = new URL(GOOGLE_SEARCH_ENDPOINT);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('cx', cx);
  url.searchParams.set('q', searchQuery);
  url.searchParams.set('num', '10'); // max allowed per request by the API

  try {
    const googleRes = await fetch(url.toString());
    const data = await googleRes.json();

    if (!googleRes.ok) {
      const message = data?.error?.message || 'Google Custom Search API request failed.';
      res.statusCode = googleRes.status;
      return res.end(JSON.stringify({ error: message }));
    }

    const items = Array.isArray(data.items) ? data.items : [];

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
      // De-duplicate by name in case Google returns near-identical listings.
      .filter((p, idx, arr) => arr.findIndex(x => x.name === p.name) === idx);

    res.statusCode = 200;
    return res.end(JSON.stringify({ prospects }));

  } catch (err) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: 'Failed to reach Google Custom Search API.', detail: err.message }));
  }
};
