/**
 * GET /api/verify-email?name=John%20Doe&domain=example.com&mode=smtp
 *
 * 1. Generates common corporate email permutations for the given name + domain.
 * 2. Verifies them either via:
 *      mode=smtp -> raw MX lookup + HELO/MAIL FROM/RCPT TO handshake (free, no external API,
 *                   but requires outbound port 25 to be open — works locally, generally
 *                   BLOCKED on Vercel/AWS Lambda by default)
 *      mode=api  -> placeholder for a free-tier third-party verification API
 *                   (fill in VERIFY_API_URL / VERIFY_API_KEY in .env)
 * 3. Returns the first pattern that verifies as deliverable, or a best-guess fallback.
 *
 * Response shape: { email, verified, checkedPatterns, mode }
 */

const dns = require('dns').promises;
const net = require('net');

const SMTP_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// 1. Permutation generator
// ---------------------------------------------------------------------------

function splitName(fullName) {
  const parts = fullName.trim().toLowerCase().replace(/[^a-z\s'-]/g, '').split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  const first = parts[0];
  const last = parts[parts.length - 1]; // ignore middle names for permutations
  return { first, last };
}

function generatePermutations(fullName, domain) {
  const { first, last } = splitName(fullName);
  if (!first) return [];

  const fInitial = first[0];
  const lInitial = last ? last[0] : '';

  const patterns = [];
  if (first && last) {
    patterns.push(`${first}.${last}@${domain}`);       // john.doe@
    patterns.push(`${fInitial}${last}@${domain}`);     // jdoe@
    patterns.push(`${first}${lInitial}@${domain}`);    // johnd@
    patterns.push(`${first}_${last}@${domain}`);       // john_doe@
    patterns.push(`${last}.${first}@${domain}`);       // doe.john@
    patterns.push(`${fInitial}.${last}@${domain}`);    // j.doe@
  }
  patterns.push(`${first}@${domain}`);                 // john@

  // De-duplicate while preserving order.
  return [...new Set(patterns)];
}

// ---------------------------------------------------------------------------
// 2a. SMTP handshake verification
// ---------------------------------------------------------------------------

async function getMxHost(domain) {
  const records = await dns.resolveMx(domain);
  if (!records || records.length === 0) {
    throw new Error(`No MX records found for ${domain}`);
  }
  // Lowest priority number = highest precedence.
  records.sort((a, b) => a.priority - b.priority);
  return records[0].exchange;
}

/**
 * Opens a raw socket to the mail server and runs a HELO/MAIL FROM/RCPT TO
 * handshake for a single candidate address, without sending an actual email.
 * Resolves to true (deliverable), false (rejected), or throws on timeout/error.
 */
function smtpCheck(mxHost, candidateEmail, fromDomain) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(25, mxHost);
    let step = 0;
    let settled = false;
    let buffer = '';

    const commands = [
      `HELO ${fromDomain}\r\n`,
      `MAIL FROM:<verify@${fromDomain}>\r\n`,
      `RCPT TO:<${candidateEmail}>\r\n`
    ];

    const finish = (result, err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => {
      finish(null, new Error(`SMTP check timed out for ${mxHost}`));
    }, SMTP_TIMEOUT_MS);

    socket.on('connect', () => {
      // Wait for the server's 220 greeting before sending HELO.
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\r\n').filter(Boolean);
      const lastLine = lines[lines.length - 1] || '';
      const code = parseInt(lastLine.slice(0, 3), 10);

      // Multi-line SMTP responses use "250-" for continuation, "250 " for the final line.
      if (/^\d{3}-/.test(lastLine)) return; // wait for the final line of a multi-line response

      if (step === 0) {
        // Expecting 220 greeting
        if (code === 220) {
          socket.write(commands[0]);
          step = 1;
        } else {
          finish(null, new Error(`Unexpected greeting code ${code} from ${mxHost}`));
        }
      } else if (step === 1) {
        // Response to HELO
        if (code === 250) {
          socket.write(commands[1]);
          step = 2;
        } else {
          finish(false); // server rejected HELO — treat as non-deliverable rather than erroring
        }
      } else if (step === 2) {
        // Response to MAIL FROM
        if (code === 250) {
          socket.write(commands[2]);
          step = 3;
        } else {
          finish(false);
        }
      } else if (step === 3) {
        // Response to RCPT TO — this is the actual existence check.
        // 250 = accepted (mailbox exists / server confirms deliverability)
        // 550/551/553 = mailbox does not exist
        // Anything else (e.g. 450, 421) = inconclusive, treat as not verified
        finish(code === 250);
      }

      buffer = '';
    });

    socket.on('error', (err) => finish(null, err));
    socket.on('timeout', () => finish(null, new Error('Socket timeout')));
  });
}

async function verifyViaSmtp(domain, candidates) {
  let mxHost;
  try {
    mxHost = await getMxHost(domain);
  } catch (err) {
    return { verifiedEmail: null, error: `MX lookup failed: ${err.message}` };
  }

  const fromDomain = 'prospector.local'; // sender domain used in HELO/MAIL FROM — not the target domain

  for (const candidate of candidates) {
    try {
      const isDeliverable = await smtpCheck(mxHost, candidate, fromDomain);
      if (isDeliverable) {
        return { verifiedEmail: candidate, error: null };
      }
      // false = confirmed non-deliverable, try the next pattern
    } catch (err) {
      // Timeout/connection error is inconclusive for this candidate — move to the next one.
      // Many mail servers (e.g. Gmail/Outlook-hosted domains) block or greylist this kind of
      // probing entirely, in which case every candidate will error out here.
      continue;
    }
  }

  return { verifiedEmail: null, error: null };
}

// ---------------------------------------------------------------------------
// 2b. Third-party free-tier API verification (placeholder)
// ---------------------------------------------------------------------------

async function verifyViaApi(domain, candidates) {
  const apiUrl = process.env.VERIFY_API_URL;
  const apiKey = process.env.VERIFY_API_KEY;

  if (!apiUrl || !apiKey) {
    return {
      verifiedEmail: null,
      error: 'VERIFY_API_URL / VERIFY_API_KEY not configured. Add a free-tier verification provider to .env to use mode=api.'
    };
  }

  // ---- Plug in your chosen provider's request/response shape here. ----
  // Example skeleton (adjust query params / auth header / response field names
  // to match whichever free-tier verifier you pick):
  //
  // for (const candidate of candidates) {
  //   const res = await fetch(`${apiUrl}?email=${encodeURIComponent(candidate)}&api_key=${apiKey}`);
  //   const data = await res.json();
  //   if (data.result === 'deliverable' || data.status === 'valid') {
  //     return { verifiedEmail: candidate, error: null };
  //   }
  // }

  return { verifiedEmail: null, error: 'API verification provider not yet wired in — see placeholder in verify-email.js.' };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  const name = (req.query.name || '').toString().trim();
  const domain = (req.query.domain || '').toString().trim().toLowerCase();
  const mode = (req.query.mode || process.env.VERIFY_MODE || 'smtp').toString().toLowerCase();

  if (!name || !domain) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Missing required query parameters: name, domain' }));
  }

  const candidates = generatePermutations(name, domain);
  if (candidates.length === 0) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: 'Could not generate email permutations from the given name.' }));
  }

  let result;
  if (mode === 'api') {
    result = await verifyViaApi(domain, candidates);
  } else {
    result = await verifyViaSmtp(domain, candidates);
  }

  const email = result.verifiedEmail || candidates[0]; // fall back to best-guess pattern if nothing verified
  const verified = Boolean(result.verifiedEmail);

  res.statusCode = 200;
  return res.end(JSON.stringify({
    email,
    verified,
    checkedPatterns: candidates,
    mode,
    note: result.error || undefined
  }));
};
