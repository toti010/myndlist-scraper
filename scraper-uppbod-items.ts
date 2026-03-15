import "dotenv/config";
import axios from "axios";
import * as cheerio from "cheerio";
import { MongoClient, Collection, ObjectId } from "mongodb";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

// ── Config ────────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI!;
const DB_NAME = "myndlist";
const ITEMS_COLLECTION = "auction_items";
const ARTISTS_COLLECTION = "artists";

const ITEM_BASE_URL = "https://www.myndlist.is/auction/AuctionItemDetails.aspx?ItemID=";
const DELAY_MS = 1500;
const MAX_MISSES = 10;
const FIRST_ITEM_ID = 14546;
//last item id 28097

const TEST_MODE = process.env.TEST_MODE === "true";
const TEST_ITEM_LIMIT = 10;
const TEST_ITEMS_COLLECTION = "auction_items_test";
const TEST_ARTISTS_COLLECTION = "artists_test";
const TEST_START_ID = 28000;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID!;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID!;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY!;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME!;
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL!;

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
});

// ── Types ─────────────────────────────────────────────────────────────────────
interface Artist {
  name: string;
  alias: string | null;
  yearBorn: number | null;
  yearDied: number | null;
  scrapedAt: Date;
}

interface AuctionItem {
  auctionId: string | null;
  itemId: number;
  scraperType: "uppbod";
  itemNumber: string | null;
  artistId: ObjectId | null;
  artist: string | null;
  lifespan: string | null;
  title: string | null;
  medium: string | null;
  year: string | null;
  category: string | null;
  estimateMin: number | null;
  estimateMax: number | null;
  hammerPrice: number | null;
  cmWidth: number | null;
  cmHeight: number | null;
  signed: boolean | null;
  imageUrl: string | null;
  scrapedAt: Date;
  sourceUrl: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

function parseAmount(str: string): number | null {
  const cleaned = str.replace(/[^\d]/g, "");
  return cleaned ? parseInt(cleaned, 10) : null;
}

function parseArtist(raw: string): Artist {
  const yearsMatch = raw.match(/\((\d{4})(?:[-–](\d{4}))?\)\s*$/);
  const yearBorn = yearsMatch ? parseInt(yearsMatch[1], 10) : null;
  const yearDied = yearsMatch?.[2] ? parseInt(yearsMatch[2], 10) : null;
  const namePart = raw.replace(/\s*\(\d{4}(?:[-–]\d{4})?\)\s*$/, "").trim();
  const aliasSplit = namePart.split(/\s*[-–]\s*/);
  let name: string;
  let alias: string | null = null;
  if (aliasSplit.length >= 2) {
    alias = aliasSplit[0].trim();
    name = aliasSplit.slice(1).join(" - ").trim();
  } else {
    name = namePart;
  }
  return { name, alias, yearBorn, yearDied, scrapedAt: new Date() };
}

// ── R2 Upload ─────────────────────────────────────────────────────────────────
async function uploadImageToR2(itemId: number, sourceUrl: string): Promise<string | null> {
  const key = `myndlist/${itemId}.jpg`;
  try {
    await r2.send(new HeadObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }));
    console.log(`    🖼  Image already in R2, skipping upload.`);
    return `${R2_PUBLIC_URL}/${key}`;
  } catch { /* not exists, upload below */ }

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
    console.log(`    🖼  Image uploaded to R2: ${key}`);
    return `${R2_PUBLIC_URL}/${key}`;
  } catch (err) {
    console.error(`    ⚠️  Failed to upload image for ItemID ${itemId}:`, err);
    return null;
  }
}

// ── Fetch Item ────────────────────────────────────────────────────────────────
async function fetchItem(itemId: number): Promise<AuctionItem | null> {
  const url = `${ITEM_BASE_URL}${itemId}`;
  let html: string;

  try {
    const res = await axios.get(url, {
      timeout: 10_000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; research-bot/1.0)" },
    });
    html = res.data as string;
  } catch {
    return null;
  }

  const $ = cheerio.load(html);
  const bodyText = $("body").text();

  if (!bodyText.includes("venjuleg uppboði") && !bodyText.includes("Verðmat")) return null;

  // Detect empty/placeholder pages
  if (bodyText.includes("Artist") && bodyText.includes("Appraisment")) return null;

  // ── Item number & artist ───────────────────────────────────────────────────
  const lines = bodyText.split("\n").map((l: string) => l.trim()).filter(Boolean);
  let headerLine: string | null = null;
  let detailLine: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    if (/^\d+\s*[-–]\s*.+/.test(lines[i]) && lines[i].length < 120) {
      headerLine = lines[i];
      detailLine = lines[i + 1] ?? null;
      break;
    }
  }

  const headerMatch = headerLine?.match(/^(\d+)\s*[-–]\s*(.+)/);
  const itemNumber = headerMatch?.[1]?.trim() ?? null;
  const artistRaw = headerMatch?.[2]?.trim() ?? null;
  const yearsMatch = artistRaw?.match(/\((\d{4}(?:[-–]\d{4})?)\)\s*$/);
  const lifespan = yearsMatch?.[1]?.trim() ?? null;
  const artist = artistRaw?.replace(/\s*\(\d{4}(?:[-–]\d{4})?\)\s*$/, "").trim() ?? null;

  // ── Detail line ────────────────────────────────────────────────────────────
  let title: string | null = null;
  let medium: string | null = null;
  let year: string | null = null;
  let cmWidth: number | null = null;
  let cmHeight: number | null = null;
  let signed: boolean | null = null;

  if (detailLine) {
    const parts = detailLine.replace(/\s*cm\s*/gi, "").split(/\s*[-–]\s*/);
    title = parts[0]?.trim() ?? null;

    for (const part of parts.slice(1)) {
      const p = part.trim();
      if (/^\d{4}$/.test(p)) { year = p; continue; }
      if (/^\d+x\d+$/.test(p)) {
        const dimMatch = p.match(/(\d+)x(\d+)/);
        cmWidth = dimMatch ? parseInt(dimMatch[2], 10) : null;
        cmHeight = dimMatch ? parseInt(dimMatch[1], 10) : null;
        continue;
      }
      if (/ómerkt/i.test(p)) { signed = false; continue; }
      if (/merkt/i.test(p)) { signed = true; continue; }
      if (p && !medium) medium = p;
    }
  }

  // ── Estimate ───────────────────────────────────────────────────────────────
  const estRangeMatch = bodyText.match(/Verðmat:\s*([\d.,]+)\s*[-–]\s*([\d.,]+)/);
  const estSingleMatch = bodyText.match(/Verðmat:\s*([\d.,]+)/);
  const estimateMin = estRangeMatch ? parseAmount(estRangeMatch[1]) : null;
  const estimateMax = estRangeMatch ? parseAmount(estRangeMatch[2]) : (estSingleMatch ? parseAmount(estSingleMatch[1]) : null);

  // ── Image ──────────────────────────────────────────────────────────────────
  const imgHrefMatch = html.match(/id="ctl00_ContentPlaceHolder1_ZoomPicture"[^>]*href="([^"]+)"/);
  const sourceImageUrl = imgHrefMatch?.[1] ?? null;
  const imageUrl = sourceImageUrl ? await uploadImageToR2(itemId, sourceImageUrl) : null;

  return {
    auctionId: null,
    itemId,
    scraperType: "uppbod",
    itemNumber,
    artistId: null,
    artist,
    lifespan,
    title,
    medium,
    year,
    category: null,
    estimateMin,
    estimateMax,
    hammerPrice: null,
    cmWidth,
    cmHeight,
    signed,
    imageUrl,
    scrapedAt: new Date(),
    sourceUrl: url,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!MONGO_URI) throw new Error("MONGODB_URI is not set.");

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log("✅ Connected to MongoDB");

  const itemsCol: Collection<AuctionItem> = client.db(DB_NAME).collection(
    TEST_MODE ? TEST_ITEMS_COLLECTION : ITEMS_COLLECTION
  );
  const artistsCol: Collection<Artist> = client.db(DB_NAME).collection(
    TEST_MODE ? TEST_ARTISTS_COLLECTION : ARTISTS_COLLECTION
  );

  if (TEST_MODE) {
    console.log(`🧪 TEST MODE — up to ${TEST_ITEM_LIMIT} items starting from ID ${TEST_START_ID}\n`);
  }

  // Find highest itemId already stored for AuctionItemDetails items
  const latest = await itemsCol
    .find({ sourceUrl: { $regex: "AuctionItemDetails" } })
    .sort({ itemId: -1 })
    .limit(1)
    .toArray();

  const startId = TEST_MODE ? TEST_START_ID : (latest.length > 0 ? latest[0].itemId + 1 : FIRST_ITEM_ID);
  console.log(`🔍 Starting from ItemID ${startId}\n`);

  let misses = 0;
  let saved = 0;
  let id = startId;

  while (misses < MAX_MISSES) {
    if (TEST_MODE && saved >= TEST_ITEM_LIMIT) {
      console.log(`\n🧪 Test limit of ${TEST_ITEM_LIMIT} items reached.`);
      break;
    }

    console.log(`Fetching ItemID ${id}...`);
    const item = await fetchItem(id);

    if (!item) {
      misses++;
      console.log(`  ✗ No valid item (miss ${misses}/${MAX_MISSES})`);
    } else if (!item.artist || !item.title) {
      console.log(`  ⏭  ItemID ${id}: missing artist or title, skipping.`);
    } else {
      misses = 0;

      if (item.artist) {
        const artistRaw = item.lifespan ? `${item.artist} (${item.lifespan})` : item.artist;
        const artistData = parseArtist(artistRaw);
        const artistResult = await artistsCol.findOneAndUpdate(
          { name: artistData.name },
          { $set: artistData },
          { upsert: true, returnDocument: "after" }
        );
        item.artistId = artistResult?._id ?? null;
      }

      // Don't overwrite items already linked to an auction by scraper-uppbod-results
      const existing = await itemsCol.findOne({ itemId: id, scraperType: "uppbod" });
      if (existing?.auctionId) {
        console.log(`  ⏭  ItemID ${id} already linked to auction, skipping.`);
      } else {
        await itemsCol.updateOne({ itemId: id, scraperType: "uppbod" }, { $set: item }, { upsert: true });
        console.log(`  ✓ Saved: "${item.title}" by ${item.artist}`);
        saved++;
      }
    }

    id++;
    await delay(DELAY_MS);
  }

  console.log(`\n🏁 Done. Saved ${saved} items.`);
  await client.close();
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});