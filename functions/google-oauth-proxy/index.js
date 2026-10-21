const functions = require('@google-cloud/functions-framework');
const { dispatch } = require('./router');

// Keep the deployed Cloud Function entrypoint stable; route dispatch is path-based
// so additional handlers can be added without colliding with Next's root proxy.ts.
functions.http('tokenProxy', dispatch);
