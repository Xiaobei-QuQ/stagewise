import { createProxyMiddleware } from 'http-proxy-middleware';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { configResolver } from '../config';
import { errorPage } from './error-page';
import { log } from '../utils/logger';
import { applyHeaderRewrites } from './proxy-utils/headers-rewrites';

export const PROXY_PREFIX = '/__stagewise_proxy__';

export const proxy = createProxyMiddleware({
  changeOrigin: true,
  pathFilter: (pathname: string, req: IncomingMessage) => {
    // Always proxy requests with the proxy prefix (iframe navigation)
    if (pathname.startsWith(PROXY_PREFIX)) {
      log.debug(`Proxying (prefixed): ${pathname}`);
      return true;
    }

    // Never proxy toolbar-app asset requests
    if (pathname.startsWith('/stagewise-toolbar-app')) {
      return false;
    }

    // Use sec-fetch-dest if available (normal browsers with full headers)
    const secFetchDest = req.headers['sec-fetch-dest'];
    if (secFetchDest !== undefined) {
      if (secFetchDest === 'document') {
        log.debug(`Not proxying ${pathname} - document navigation`);
        return false;
      }
      log.debug(`Proxying request: ${pathname}`);
      return true;
    }

    // When sec-fetch-dest is missing (e.g. remote access stripping headers):
    // - HTML navigations (Accept starts with text/html) without the prefix
    //   are top-level navigations → serve toolbar HTML
    // - Everything else (JS, CSS, images, API calls) → proxy to dev server
    const accept = req.headers['accept'] ?? '';
    if (accept.startsWith('text/html')) {
      log.debug(`Not proxying ${pathname} - html accept without prefix, serving toolbar`);
      return false;
    }

    log.debug(`Proxying request (no sec-fetch-dest): ${pathname}`);
    return true;
  },
  pathRewrite: {
    [`^${PROXY_PREFIX}`]: '',
  },
  followRedirects: false,
  router: () => {
    const config = configResolver.getConfig();
    return `http://localhost:${config.appPort}`;
  },
  ws: false,
  cookieDomainRewrite: {
    '*': '',
  },
  autoRewrite: true,
  preserveHeaderKeyCase: true,
  xfwd: true,
  on: {
    // @ts-expect-error
    error: (err, _req, res: ServerResponse<IncomingMessage>) => {
      log.error(`Proxy error: ${err.message}`);
      const config = configResolver.getConfig();
      res.writeHead(503, { 'Content-Type': 'text/html' });
      res.end(errorPage(config.appPort));
    },
    proxyRes: (proxyRes) => {
      applyHeaderRewrites(proxyRes);
    },
    proxyReqWs: (_proxyReq, req, _socket, _options, _head) => {
      log.debug(`WebSocket proxy request: ${req.url}`);
    },
  },
});
