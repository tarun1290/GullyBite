// wsDisconnect Lambda — runs when a WebSocket connection closes.
// Removes the connection record from DynamoDB.

const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, DeleteCommand } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: process.env.AWS_REGION }));
const TABLE = process.env.DYNAMODB_TABLE || 'gullybite-ws-connections';

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;

  try {
    await ddb.send(new DeleteCommand({
      TableName: TABLE,
      Key: { connectionId },
    }));
    console.log(`Disconnected: ${connectionId}`);
  } catch (err) {
    console.error(`Failed to delete connection ${connectionId}:`, err.message);
  }

  return { statusCode: 200, body: 'Disconnected' };
};
