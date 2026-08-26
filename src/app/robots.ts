import type { MetadataRoute } from 'next';

/**
 * `robots.txt`.
 *
 * Nothing here is blocked, but until now nothing was declared either, and an
 * absent file leaves the answer to whatever a platform or CDN decides to serve.
 * The four AI crawlers the Discovery Service checks for are named explicitly so
 * that allowing them is a stated fact rather than an accident of the default.
 */

/** Checked by the Discovery Service's `/api/discovery/crawlers` probe. */
const AI_CRAWLERS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/' },
      ...AI_CRAWLERS.map((userAgent) => ({ userAgent, allow: '/' })),
    ],
  };
}
