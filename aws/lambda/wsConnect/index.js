// wsConnect Lambda — runs when a dashboard client opens a WebSocket connection.
// Validates JWT, determines room, saves connection to DynamoDB.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand } = require('@aws-sdk/lib-dynamodb');
const jwt = require('jsonwebtoken');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const TABLE = process.env.DYNAMODB_TABLE || 'gullybite-ws-connections';
const JWT_SECRET = process.env.JWT_SECRET;

exports.handler = async (event) => {
  const params = event.queryStringParameters || {};
  const token = params.token;
  const roomOverride = params.room;

  if (!token) return { statusCode: 401, body: 'Missing token' };

  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    console.error('JWT verification failed:', err.message);
    return { statusCode: 401, body: 'Invalid token' };
  }

  const connectionId = event.requestContext.connectionId;
  const isAdmin = decoded.role === 'admin' || !!decoded.isAdmin;
  const restaurantId = decoded.restaurantId || null;
  const userId = decoded.userId || decoded.metaUserId || decoded.sub || null;

  // Determine room
  let room;
  if (roomOverride) {
    room = roomOverride;
  } else if (isAdmin) {
    room = 'admin:global';
  } else if (restaurantId) {
    room = `restaurant:${restaurantId}`;
  } else {
    return { statusCode: 401, body: 'Cannot determine room' };
  }

  const ttl = Math.floor(Date.now() / 1000) + 86400; // 24 hours

  await ddb.send(new PutCommand({
    TableName: TABLE,
    Item: {
      connectionId,
      room,
      userId,
      restaurantId,
      role: isAdmin ? 'admin' : 'restaurant',
      connectedAt: new Date().toISOString(),
      ttl,
    },
  }));

  console.log(`Connected: ${connectionId} → room=${room} userId=${userId}`);
  return { statusCode: 200, body: 'Connected' };
};
