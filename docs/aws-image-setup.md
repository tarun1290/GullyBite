# AWS S3 + CloudFront — Product Image Pipeline Setup

All product images are stored in a private S3 bucket and served via CloudFront CDN.
This ensures fast, globally-cached delivery with HTTPS URLs that Meta's catalog system accepts.

---

## 1. Create S3 Bucket

**AWS Console > S3 > Create bucket**

| Setting | Value |
|---------|-------|
| Bucket name | `gullybite-images` (or your preferred name) |
| Region | `ap-south-1` (Mumbai — closest to Indian users) |
| Block all public access | **YES** (images served via CloudFront only) |
| Bucket versioning | Disabled |
| Encryption | SSE-S3 (default) |

### CORS Configuration

If using presigned URLs for direct browser uploads (optional):

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "POST"],
    "AllowedOrigins": ["https://your-dashboard-domain.com"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

---

## 2. Create CloudFront Distribution

**AWS Console > CloudFront > Create distribution**

| Setting | Value |
|---------|-------|
| Origin domain | `gullybite-images.s3.ap-south-1.amazonaws.com` |
| Origin access | **Origin Access Control (OAC)** — create new |
| Default cache behavior | Cache policy: `CachingOptimized` |
| Price class | Use North America, Europe, Asia, Middle East, and Africa |
| Default TTL | 2592000 (30 days) |
| Compress objects | Yes |
| Viewer protocol policy | Redirect HTTP to HTTPS |

### Custom domain (optional)

To use `images.gullybite.com` instead of the CloudFront domain:

1. Request an SSL certificate in ACM (must be in `us-east-1` for CloudFront)
2. Add `images.gullybite.com` as an alternate domain in CloudFront
3. Add a CNAME record: `images.gullybite.com` → `d1234567890.cloudfront.net`

After creation, note the CloudFront domain: `d1234567890.cloudfront.net`

---

## 3. S3 Bucket Policy

After creating the CloudFront distribution, update the S3 bucket policy to allow CloudFront access:

**S3 > your bucket > Permissions > Bucket policy:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipal",
      "Effect": "Allow",
      "Principal": {
        "Service": "cloudfront.amazonaws.com"
      },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::gullybite-images/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::YOUR_ACCOUNT_ID:distribution/YOUR_DISTRIBUTION_ID"
        }
      }
    }
  ]
}
```

Replace `YOUR_ACCOUNT_ID` and `YOUR_DISTRIBUTION_ID` with your actual values.

---

## 4. Create IAM User

**AWS Console > IAM > Users > Create user**

| Setting | Value |
|---------|-------|
| User name | `gullybite-image-uploader` |
| Access type | Programmatic access only |

### Inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:GetObject",
        "s3:ListBucket"
      ],
      "Resource": [
        "arn:aws:s3:::gullybite-images",
        "arn:aws:s3:::gullybite-images/*"
      ]
    }
  ]
}
```

Generate an access key and secret. Add to your `.env`:

```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-south-1
AWS_S3_BUCKET=gullybite-images
AWS_CLOUDFRONT_DOMAIN=d1234567890.cloudfront.net
```

---

## 5. Upload Placeholder Images

Upload category placeholder images to S3 under the `placeholders/` prefix:

```
placeholders/default-food.jpg
placeholders/default-beverage.jpg
placeholders/momos.jpg
placeholders/biryani.jpg
placeholders/curry.jpg
placeholders/pizza.jpg
placeholders/burger.jpg
placeholders/sandwich.jpg
placeholders/salad.jpg
placeholders/coffee.jpg
placeholders/tea.jpg
placeholders/matcha.jpg
placeholders/desserts.jpg
placeholders/pastry.jpg
placeholders/mocktails.jpg
placeholders/milkshakes.jpg
placeholders/sushi.jpg
placeholders/noodles.jpg
placeholders/soup.jpg
placeholders/thali.jpg
```

Requirements: JPEG, minimum 500x500px, under 1MB each.
These are used as fallbacks for menu items without photos — Meta rejects products with empty image_link.

Upload via AWS CLI:
```bash
aws s3 sync ./placeholder-images/ s3://gullybite-images/placeholders/ --content-type image/jpeg
```

---

## 6. S3 Key Structure

Images are organized by restaurant and branch:

```
{restaurant_id}/
  logo-{timestamp}.jpg                    # Restaurant logo
  {branch_id}/
    branch-photo-{timestamp}.jpg          # Storefront photo
    {item_id}-{timestamp}.jpg             # Menu item main image
    thumb-{item_id}-{timestamp}.jpg       # Menu item thumbnail (200x200)
placeholders/
  default-food.jpg                        # Generic food fallback
  default-beverage.jpg                    # Generic beverage fallback
  biryani.jpg                             # Category-specific placeholders
  ...
```

---

## 7. Verify Setup

1. Upload a test image: `aws s3 cp test.jpg s3://gullybite-images/test.jpg`
2. Access via CloudFront: `https://d1234567890.cloudfront.net/test.jpg`
3. Should load the image over HTTPS
4. Clean up: `aws s3 rm s3://gullybite-images/test.jpg`
