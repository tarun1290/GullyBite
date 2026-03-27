// wsBroadcast Lambda — called by Vercel backend via HTTP (Function URL).
// Pushes messages to connected WebSocket clients via API Gateway Management API.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, QueryCommand, DeleteCommand } = require('@aws-sdk/lib-dynamodb');
const { ApiGatewayManagementApiClient, PostToConnectionCommand } = require('@aws-sdk/client-apigatewaymanagementapi');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const TABLE = process.env.DYNAMODB_TABLE || 'gullybite-ws-connections';
const BROADCAST_API_KEY = process.env.BROADCAST_API_KEY;

let apigw;
function getApigw() {
  if (!apigw) {
    apigw = new ApiGatewayManagementApiClient({
      region: process.env.AWS_REGION,
      endpoint: process.env.WEBSOCKET_API_ENDPOINT,
    });
  }
  return apigw;
}

exports.handler = async (event) => {
  // Auth check
  const apiKey = event.headers?.['x-api-key'] || event.headers?.['X-Api-Key'];
  if (!apiKey || apiKey !== BROADCAST_API_KEY) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Forbidden' }) };
  }

  let body;
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { event: eventName, data } = body;
  const rooms = body.rooms || (body.room ? [body.room] : []);

  if (!eventName || !rooms.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'event and room/rooms required' }) };
  }

  // Collect all connectionIds for all rooms
  const connectionSet = new Map(); // connectionId → true (dedup)

  for (const room of rooms) {
    try {
      const result = await ddb.send(new QueryCommand({
        TableName: TABLE,
        IndexName: 'room-index',
        KeyConditionExpression: 'room = :r',
        ExpressionAttributeValues: { ':r': room },
      }));
      for (const item of (result.Items || [])) {
        connectionSet.set(item.connectionId, true);
      }
    } catch (err) {
      console.error(`DynamoDB query failed for room ${room}:`, err.message);
    }
  }

  const payload = Buffer.from(JSON.stringify({ event: eventName, data }));
  const mgmt = getApigw();
  let sent = 0, failed = 0;

  const promises = [...connectionSet.keys()].map(async (connectionId) => {
    try {
      await mgmt.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: payload,
      }));
      sent++;
    } catch (err) {
      if (err.statusCode === 410 || err.$metadata?.httpStatusCode === 410) {
        // Stale connection — clean up
        ddb.send(new DeleteCommand({ TableName: TABLE, Key: { connectionId } })).catch(() => {});
      }
      failed++;
    }
  });

  await Promise.allSettled(promises);

  console.log(`Broadcast ${eventName} to ${rooms.join(',')} — sent=${sent} failed=${failed}`);
  return {
    statusCode: 200,
    body: JSON.stringify({ sent, failed }),
  };
};
