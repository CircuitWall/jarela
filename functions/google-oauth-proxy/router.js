const { handleOAuthToken } = require('./handlers/oauth-token');

const handlersByPath = new Map([
  // Keep the deployed URL working; namespaced routes are preferred for new handlers.
  ['/', handleOAuthToken],
  ['/oauth2/token', handleOAuthToken],
]);

function createRequestDispatcher(handlers = handlersByPath) {
  return (req, res) => {
    let pathname = '/';
    try {
      pathname = new URL(req.originalUrl || req.url || req.path || '/', 'http://localhost').pathname;
    } catch {
      return res.status(400).json({ error: 'invalid_path' });
    }
    pathname = pathname.replace(/\/+$/, '') || '/';
    const handler = handlers.get(pathname);
    if (!handler) return res.status(404).json({ error: 'not_found' });
    return handler(req, res);
  };
}

module.exports = { createRequestDispatcher, dispatch: createRequestDispatcher() };
