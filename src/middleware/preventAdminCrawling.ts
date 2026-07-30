// src/middleware/preventAdminCrawling.ts

import { Request, Response, NextFunction } from 'express';
import { CrawlerBlockedError } from '../lib/errors.js';

const KNOWN_CRAWLERS = [
  'googlebot',
  'bingbot',
  'yandexbot',
  'duckduckbot',
  'slurp',
  'baiduspider',
  'ia_archiver',
  'bot',
  'crawler',
  'spider'
];

export const preventAdminCrawling = (req: Request, res: Response, next: NextFunction) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');

  const userAgent = (req.headers['user-agent'] || '').toLowerCase();
  const isCrawler = KNOWN_CRAWLERS.some((bot) => userAgent.includes(bot));

  if (isCrawler) {
    return next(new CrawlerBlockedError());
  }

  next();
};