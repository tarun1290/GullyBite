# AWS Lambda Functions

GullyBite uses four Lambda functions deployed to `ap-south-1`:

| Function | Runtime | Trigger | Purpose |
|---|---|---|---|
| **wsConnect** | Node.js 20 | API Gateway WebSocket `$connect` | Validates JWT, stores connection in DynamoDB |
| **wsDisconnect** | Node.js 20 | API Gateway WebSocket `$disconnect` | Removes connection from DynamoDB |
| **wsBroadcast** | Node.js 20 | HTTP Function URL (called by backend) | Pushes real-time events to dashboard clients |
| **imageResize** | Node.js 20 | S3 trigger on `uploads/` prefix | Creates thumbnail (200px) and medium (600px) variants |

## Directory Structure

```
aws/lambda/
├── wsConnect/          # WebSocket connect handler
│   ├── index.js
│   └── package.json
├── wsDisconnect/       # WebSocket disconnect handler
│   ├── index.js
│   └── package.json
├── wsBroadcast/        # Real-time broadcast via API GW Management API
│   ├── index.js
│   └── package.json
├── imageResize/        # S3 image resize (sharp)
│   ├── index.mjs
│   └── package.json
└── package.json        # Shared dependency reference
```

## Build & Deploy

All lambdas are built and deployed via the script at `scripts/deploy-lambdas.sh`.

### Prerequisites

- AWS CLI configured with credentials (`aws configure`)
- Node.js 20+ and npm
- `zip` command available

### Commands

```bash
# Build all lambdas (creates zip files in each lambda's build/ dir)
./scripts/deploy-lambdas.sh build

# Deploy all lambdas to AWS
./scripts/deploy-lambdas.sh deploy

# Build + deploy all in one step
./scripts/deploy-lambdas.sh

# Build + deploy a single lambda
./scripts/deploy-lambdas.sh wsConnect
```

Build artifacts (zip files) are written to `aws/lambda/<name>/build/` and are git-ignored.

### Environment Variables

Each Lambda requires environment variables configured in the AWS Console or via IaC:

**wsConnect / wsDisconnect / wsBroadcast:**
- `AWS_REGION` — DynamoDB region
- `DYNAMODB_TABLE` — Connection table name (`gullybite-ws-connections`)
- `JWT_SECRET` — Same secret used by the backend
- `WEBSOCKET_API_ENDPOINT` — API Gateway WebSocket management URL (wsBroadcast only)
- `BROADCAST_API_KEY` — Shared key for backend → wsBroadcast auth (wsBroadcast only)

**imageResize:**
- `AWS_REGION` — S3 region
- `S3_BUCKET_NAME` — Source bucket name
- `CLOUDFRONT_URL` — CloudFront distribution URL for logging

## Notes

- The `imageResize` lambda uses ES modules (`index.mjs`) because `sharp` works best with ESM imports.
- WebSocket lambdas share the same DynamoDB table with a `room-index` GSI on the `room` field.
- Zip artifacts and `node_modules/` are never committed — they are built fresh by the deploy script.
