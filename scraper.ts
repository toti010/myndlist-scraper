import axios from "axios";
import * as cheerio from "cheerio";
import { MongoClient, Collection } from "mongodb";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

// ── Config ────────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI!;
const DB_NAME = "myndlist";
const COLLECTION = "auction_items";
const BASE_URL = "https://www.myndlist.is/auction/WebAuctionItems.aspx?ItemID=";
const DELAY_MS = 1500;
const MAX_MISSES = 10;
const FIRST_ITEM_ID = 1;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME!;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL!; // e.g. https://pub-xxxx.r2.dev

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// ── Types ─────────────────────────────────────────────────────────────────────
interface AuctionItem {
  itemId: number;
  itemNumber: string | null;
  artist: string | null;
  lifespan: string | null;
  title: string | null;
  medium: string | null;
  year: string | null;
  dimensions: string | null;
  category: string | null;
  auctionEndDate: Date | null;
  estimateMin: number | null;
  estimateMax: number | null;
  highestBid: number | null;
  imageUrl: string | null;
  scrapedAt: Date;
  sourceUrl: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

function parseIcelandicDate(str: string): Date | null {
  // e.g. "11.3.2026 klukkan 21:52"
  const m = str.match(/(\d+)\.(\d+)\.(\d{4})\s+klukkan\s+(\d+):(\d+)/);
  if (!m) return null;
  return new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${m[4].padStart(2, "0")}:${m[5].padStart(2, "0")}:00`);
}

function parseAmount(str: string): number | null {
  const cleaned = str.replace(/[^\d]/g, "");
  return cleaned ? parseInt(cleaned, 10) : null;
}

// ── R2 Upload ─────────────────────────────────────────────────────────────────
async function uploadImageToR2(itemId: number, sourceUrl: string): Promise<string | null> {
  const key = `myndlist/${itemId}.jpg`;

  // Skip upload if image already exists in R2
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    console.log(`  🖼  Image already in R2, skipping upload.`);
    return `${R2_PUBLIC_URL}/${key}`;
  } catch {
    // Object doesn't exist yet, proceed with upload
  }

  try {
    const res = await axios.get(sourceUrl, {
      responseType: "arraybuffer",
      timeout: 15_000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; research-bot/1.0)" },
    });

    const contentType = (res.headers["content-type"] as string) || "image/jpeg";

    await r2.send(new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: Buffer.from(res.data),
      ContentType: contentType,
    }));

    console.log(`  🖼  Image uploaded to R2: ${key}`);
    return `${R2_PUBLIC_URL}/${key}`;
  } catch (err) {
    console.error(`  ⚠️  Failed to upload image for ItemID ${itemId}:`, err);
    return null;
  }
}

// ── Scraper ───────────────────────────────────────────────────────────────────
async function fetchItem(itemId: number): Promise<AuctionItem | null> {
  const url = `${BASE_URL}${itemId}`;
  let html: string;

  try {
    const res = await axios.get(url, {
      timeout: 10_000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; research-bot/1.0)" },
    });
    html = res.data as string;
  } catch {
    return null; // network error or 404
  }

  const $ = cheerio.load(html);
  const bodyText = $("body").text();

  // Empty / invalid page check
  if (!bodyText.includes("Verk nr")) return null;

  // ── Auction end date ───────────────────────────────────────────────────────
  const endMatch = bodyText.match(/Uppboði lýkur\s+([\d.]+\s+klukkan\s+[\d:]+)/);
  const auctionEndDate = endMatch ? parseIcelandicDate(endMatch[1]) : null;

  // Skip if auction has not ended yet
  if (!auctionEndDate || auctionEndDate > new Date()) {
    console.log(`  ⏭  ItemID ${itemId}: auction not yet ended, skipping.`);
    return null;
  }

  // ── Item number & artist ───────────────────────────────────────────────────
  const verkMatch = bodyText.match(/Verk\s+nr\.?\s*(\d+)\s*[-–]\s*(.+?\(\d{4}[-–]\d{4}\))/);
  const itemNumber = verkMatch?.[1]?.trim() ?? null;
  const artistFull = verkMatch?.[2]?.trim() ?? null;
  const artistMatch = artistFull?.match(/^(.+?)\s*\((\d{4}[-–]\d{4})\)$/);
  const artist = artistMatch?.[1]?.trim() ?? artistFull;
  const lifespan = artistMatch?.[2]?.trim() ?? null;

  // ── Detail line: "Title - Medium - Year. Merkt. WxH cm" ───────────────────
  const lines = bodyText.split("\n").map(l => l.trim()).filter(Boolean);
  let detailLine: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (/Verk\s+nr/i.test(lines[i])) { detailLine = lines[i + 1] ?? null; break; }
  }

  let title: string | null = null;
  let medium: string | null = null;
  let year: string | null = null;
  let dimensions: string | null = null;

  if (detailLine) {
    const parts = detailLine.split(/\s*[-–]\s*/);
    title = parts[0]?.trim() ?? null;
    medium = parts[1]?.trim() ?? null;
    const rest = parts.slice(2).join(" ");
    year = rest.match(/(\d{4})/)?.[1] ?? null;
    dimensions = detailLine.match(/(\d+\s*x\s*\d+\s*cm)/i)?.[1]?.trim() ?? null;
  }

  // ── Category ───────────────────────────────────────────────────────────────
  const catMatch = bodyText.match(/Flokkur:\s*(.+)/);
  const category = catMatch?.[1]?.split("\n")[0]?.trim() ?? null;

  // ── Estimate ───────────────────────────────────────────────────────────────
  const estMatch = bodyText.match(/Verðmat:\s*([\d.,\s]+)\s*[-–]\s*([\d.,\s]+)/);
  const estimateMin = estMatch ? parseAmount(estMatch[1]) : null;
  const estimateMax = estMatch ? parseAmount(estMatch[2]) : null;

  // ── Highest bid ────────────────────────────────────────────────────────────
  // Bids are listed newest first; first Kr. amount is the highest
  const bidMatch = bodyText.match(/Kr\.\s*\*\*([\d.,]+)\*\*/);
  const highestBid = bidMatch ? parseAmount(bidMatch[1]) : null;

  // ── Image ──────────────────────────────────────────────────────────────────
  const sourceImageUrl = $("#ctl00_ContentPlaceHolder1_ZoomPicture").attr("href") ?? null;
  const imageUrl = sourceImageUrl ? await uploadImageToR2(itemId, sourceImageUrl) : null;

  return {
    itemId,
    itemNumber,
    artist,
    lifespan,
    title,
    medium,
    year,
    dimensions,
    category,
    auctionEndDate,
    estimateMin,
    estimateMax,
    highestBid,
    imageUrl,
    scrapedAt: new Date(),
    sourceUrl: url,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!MONGO_URI) throw new Error("MONGODB_URI environment variable is not set.");

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log("✅ Connected to MongoDB");

  const col: Collection<AuctionItem> = client.db(DB_NAME).collection(COLLECTION);

  // Find highest itemId already stored
  const latest = await col.find().sort({ itemId: -1 }).limit(1).toArray();
  const startId = latest.length > 0 ? latest[0].itemId + 1 : FIRST_ITEM_ID;
  console.log(`🔍 Starting from ItemID ${startId}`);

  let misses = 0;
  let saved = 0;
  let id = startId;

  while (misses < MAX_MISSES) {
    console.log(`Fetching ItemID ${id}...`);
    const item = await fetchItem(id);

    if (item === null) {
      misses++;
      console.log(`  ✗ No valid completed item (miss ${misses}/${MAX_MISSES})`);
    } else {
      misses = 0; // reset misses on a valid find
      await col.updateOne(
        { itemId: id },
        { $set: item },
        { upsert: true }
      );
      console.log(`  ✓ Saved: "${item.title}" by ${item.artist}`);
      saved++;
    }

    id++;
    await delay(DELAY_MS);
  }

  console.log(`\n🏁 Done. Saved ${saved} new items.`);
  await client.close();
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
