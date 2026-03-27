import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import sharp from 'sharp';

const REGION = process.env.AWS_REGION;
const BUCKET = process.env.S3_BUCKET_NAME;
const CLOUDFRONT_URL = process.env.CLOUDFRONT_URL;

const s3 = new S3Client({ region: REGION });

const SIZES = [
  { name: 'thumbnail', width: 200, height: 200 },
  { name: 'medium', width: 600, height: 600 },
];

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export const handler = async (event) => {
  const records = event.Records || [];

  for (const record of records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

    // Skip already-resized images to prevent infinite loop
    if (key.includes('/resized/')) {
      console.log(`Skipping already-resized image: ${key}`);
      continue;
    }

    console.log(`Processing: ${key} from bucket ${bucket}`);

    // Fetch original image
    const getResponse = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const originalBuffer = await streamToBuffer(getResponse.Body);

    // Split key into path and filename
    const lastSlash = key.lastIndexOf('/');
    const basePath = key.substring(0, lastSlash);
    const filename = key.substring(lastSlash + 1);

    // Resize and upload each version
    for (const size of SIZES) {
      const resizedBuffer = await sharp(originalBuffer)
        .resize(size.width, size.height, { fit: 'cover', position: 'centre' })
        .jpeg({ quality: 85 })
        .toBuffer();

      const resizedKey = `${basePath}/resized/${size.name}-${filename}`;

      await s3.send(new PutObjectCommand({
        Bucket: bucket,
        Key: resizedKey,
        Body: resizedBuffer,
        ContentType: 'image/jpeg',
      }));

      const cfUrl = `${CLOUDFRONT_URL}/${resizedKey}`;
      console.log(`Uploaded ${size.name}: ${cfUrl}`);
    }
  }

  return { statusCode: 200, body: `Processed ${records.length} record(s)` };
};
