// Vercel serverless entry — imports the Express app from backend/server.js.
// vercel.json rewrites /auth/* and /api/* to this handler; the Express app
// preserves req.url and routes normally. Webhooks are NOT rewritten here —
// they continue to run on EC2 via backend/ec2-server.js.
const app = require('../backend/server');
module.exports = (req, res) => {
  return app(req, res);
};
