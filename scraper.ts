import "dotenv/config";
import axios from "axios";
import * as cheerio from "cheerio";
import { MongoClient, Collection, ObjectId } from "mongodb";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

// ── Config ────────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI!;
const DB_NAME = "myndlist";
const AUCTIONS_COLLECTION = "auctions";
const ITEMS_COLLECTION = "auction_items";
const ARTISTS_COLLECTION = "artists";

const AUCTION_BASE_URL = "https://www.myndlist.is/auction/Auctions.aspx?WebAuctionID=";
const ITEM_BASE_URL = "https://www.myndlist.is/auction/WebAuctionItems.aspx?ItemID=";

const MAX_MISSES = 40;
const FIRST_AUCTION_ID = 1;
const SKIP_RANGE_START = 240;
const SKIP_RANGE_END = 3370;
const RUN_LIMIT = 10;
const DEBUG = false; // set to true for verbose logging and reduced delay
const DELAY_MS = DEBUG ? 200 : 1500;

const TEST_MODE = process.env.TEST_MODE === "true";
const TEST_AUCTION_LIMIT = 3;
const TEST_ITEM_LIMIT = 5;
const TEST_AUCTION_COLLECTION = "auctions_test";
const TEST_ITEMS_COLLECTION = "auction_items_test";
const TEST_ARTISTS_COLLECTION = "artists_test";
const TEST_START_ID = 800;

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

interface Auction {
  auctionId: number;
  name: string | null;
  auctionNumber: string | null;
  dateFrom: Date | null;
  dateTo: Date | null;
  totalItems: number;
  scrapedAt: Date;
  sourceUrl: string;
}

interface AuctionItem {
  auctionId: number;
  itemId: number;
  scraperType: "vefuppbod";
  itemNumber: string | null;
  artistId: ObjectId | null;
  artist: string | null;
  lifespan: string | null;
  title: string | null;
  medium: string | null;
  year: string | null;
  category: string | null;
  auctionEndDate: Date | null;
  estimateMin: number | null;
  estimateMax: number | null;
  highestBid: number | null;
  highestBidUserId: string | null;
  cmWidth: number | null;
  cmHeight: number | null;
  signed: boolean | null;
  imageUrl: string | null;
  scrapedAt: Date;
  sourceUrl: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

function parseIcelandicDate(str: string, endOfDay = false): Date | null {
  const m = str.match(/(\d+)\.(\d+)\.(\d{4})(?:\s+klukkan\s+(\d+):(\d+))?/);
  if (!m) return null;
  const hasTime = !!m[4];
  const h = hasTime ? m[4] : (endOfDay ? "23" : "00");
  const min = hasTime ? m[5] : (endOfDay ? "59" : "00");
  return new Date(`${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}T${h.padStart(2, "0")}:${min.padStart(2, "0")}:00`);
}

function parseAmount(str: string): number | null {
  const cleaned = str.replace(/[^\d]/g, "");
  return cleaned ? parseInt(cleaned, 10) : null;
}

function parseArtist(raw: string): Artist {
  // Extract years e.g. "(1932)" or "(1885-1972)"
  const yearsMatch = raw.match(/\((\d{4})(?:[-–](\d{4}))?\)\s*$/);
  const yearBorn = yearsMatch ? parseInt(yearsMatch[1], 10) : null;
  const yearDied = yearsMatch?.[2] ? parseInt(yearsMatch[2], 10) : null;

  // Remove years to get name portion
  const namePart = raw.replace(/\s*\(\d{4}(?:[-–]\d{4})?\)\s*$/, "").trim();

  // Check for alias e.g. "Erró - Guðmundur Guðmundsson"
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
    if (DEBUG) console.log(`    🖼  Image already in R2, skipping upload.`);
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
    if (DEBUG) console.log(`    🖼  Image uploaded to R2: ${key}`);
    return `${R2_PUBLIC_URL}/${key}`;
  } catch (err) {
    console.error(`    ⚠️  Failed to upload image for ItemID ${itemId}:`, err);
    return null;
  }
}

// ── Fetch Auction Page ────────────────────────────────────────────────────────
async function fetchAuction(auctionId: number): Promise<{ auction: Auction; itemIds: number[] } | null> {
  const url = `${AUCTION_BASE_URL}${auctionId}`;
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

  if (!bodyText.includes("Vefuppboð")) return null;

  // ── Auction name, number and dates ─────────────────────────────────────────
  // <span> contains "Vefuppboð nr. 179<br>12.9.2015 - 23.9.2015"
  const span = $("#ctl00_ContentPlaceHolder1_lblAuction");
  const spanHtml = span.html() ?? "";
  const [titlePart, datePart] = spanHtml.split(/<br\s*\/?>/i);

  const numberMatch = titlePart?.match(/Vefuppboð\s+nr\.\s*(\d+)/);
  const auctionNumber = numberMatch?.[1]?.trim() ?? null;
  const name = auctionNumber ? `Vefuppboð nr. ${auctionNumber}` : null;

  const dateMatch = datePart?.trim().match(/(\d{1,2}\.\d{1,2}\.\d{4})\s*[-–]\s*(\d{1,2}\.\d{1,2}\.\d{4})/);
  const dateFrom = dateMatch ? parseIcelandicDate(dateMatch[1]) : null;
  const dateTo = dateMatch ? parseIcelandicDate(dateMatch[2], true) : null;

    if (DEBUG) console.log(`  📋 Auction: "${name}" | ${dateFrom?.toDateString() ?? "?"} – ${dateTo?.toDateString() ?? "?"}`);

  // Skip if auction has not ended yet
  if (!dateTo || dateTo > new Date()) {
    console.log(`  ⏭  AuctionID ${auctionId}: auction not yet ended, skipping.`);
    return null;
  }

  // ── Extract item IDs from links ────────────────────────────────────────────
  const itemIds: number[] = [];
  $("a[href*='WebAuctionItems.aspx?ItemID=']").each((_, el) => {
    const href = $(el).attr("href") ?? "";
    const m = href.match(/ItemID=(\d+)/);
    if (m) {
      const id = parseInt(m[1], 10);
      if (!itemIds.includes(id)) itemIds.push(id);
    }
  });

  return {
    auction: {
      auctionId,
      name,
      auctionNumber,
      dateFrom,
      dateTo,
      totalItems: itemIds.length,
      scrapedAt: new Date(),
      sourceUrl: url,
    },
    itemIds,
  };
}

// ── Fetch Auction Item ────────────────────────────────────────────────────────
async function fetchItem(auctionId: number, itemId: number): Promise<AuctionItem | null> {
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

  if (!bodyText.includes("Verk nr")) return null;

  // ── Auction end date ───────────────────────────────────────────────────────
  const endMatch = bodyText.match(/Uppboði lýkur\s+([\d.]+\s+klukkan\s+[\d:]+)/);
  const auctionEndDate = endMatch ? parseIcelandicDate(endMatch[1]) : null;

  // ── Item number & artist ───────────────────────────────────────────────────
  const verkMatch = bodyText.match(/Verk\s+nr\.?\s*(\d+)\s*[-–]\s*(.+?)(?:\s*\((\d{4}[-–]\d{4})\))?\s*$/m);
  const itemNumber = verkMatch?.[1]?.trim() ?? null;
  const artist = verkMatch?.[2]?.trim() ?? null;
  const lifespan = verkMatch?.[3]?.trim() ?? null;

  // ── Detail line: "Title - Medium - Year. Merkt. WxH cm" ───────────────────
  const lines = bodyText.split("\n").map((l: string) => l.trim()).filter(Boolean);
  let detailLine: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (/Verk\s+nr/i.test(lines[i])) { detailLine = lines[i + 1] ?? null; break; }
  }

  let title: string | null = null;
  let medium: string | null = null;
  let year: string | null = null;
  let cmWidth: number | null = null;
  let cmHeight: number | null = null;
  let signed: boolean | null = null;

  if (detailLine) {
    const parts = detailLine.split(/\s*[-–]\s*/);
    title = parts[0]?.trim() ?? null;
    medium = parts[1]?.trim() ?? null;
    const rest = parts.slice(2).join(" ");
    year = rest.match(/(\d{4})/)?.[1] ?? null;
    const dimMatch = detailLine.match(/(\d+)\s*x\s*(\d+)\s*cm/i);
    cmWidth = dimMatch ? parseInt(dimMatch[2], 10) : null;
    cmHeight = dimMatch ? parseInt(dimMatch[1], 10) : null;
    signed = /merkt/i.test(detailLine) ? !/ómerkt/i.test(detailLine) : null;
  }

  // ── Category ───────────────────────────────────────────────────────────────
  const catMatch = bodyText.match(/Flokkur:\s*(.+)/);
  const category = catMatch?.[1]?.split("\n")[0]?.trim() ?? null;

  // ── Estimate ───────────────────────────────────────────────────────────────
  const estRangeMatch = bodyText.match(/Verðmat:\s*([\d.,\s]+)\s*[-–]\s*([\d.,\s]+)/);
  const estSingleMatch = bodyText.match(/Verðmat:\s*([\d.,]+)/);
  const estimateMin = estRangeMatch ? parseAmount(estRangeMatch[1]) : null;
  const estimateMax = estRangeMatch ? parseAmount(estRangeMatch[2]) : (estSingleMatch ? parseAmount(estSingleMatch[1]) : null);

  // ── Highest bid ────────────────────────────────────────────────────────────
  const bidMatch = bodyText.match(/Boð\s+frá\s+(\d+):\s*Kr\.\s*([\d.,]+)\.-/);
  const highestBid = bidMatch ? parseAmount(bidMatch[2]) : null;
  const highestBidUserId = bidMatch ? bidMatch[1].trim() : null;

  // ── Image ──────────────────────────────────────────────────────────────────
  const imgHrefMatch = html.match(/id="ctl00_ContentPlaceHolder1_ZoomPicture"[^>]*href="([^"]+)"/);
  const sourceImageUrl = imgHrefMatch?.[1] ?? null;
  const imageUrl = sourceImageUrl ? await uploadImageToR2(itemId, sourceImageUrl) : null;

  return {
    auctionId,
    itemId,
    scraperType: "vefuppbod",
    itemNumber,
    artistId: null,   // set after artist upsert in main
    artist,
    lifespan,
    title,
    medium,
    year,
    category,
    auctionEndDate,
    estimateMin,
    estimateMax,
    highestBid,
    highestBidUserId,
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
  if (!MONGO_URI) throw new Error("MONGODB_URI environment variable is not set.");

  const client = new MongoClient(MONGO_URI);
  await client.connect();
  console.log("✅ Connected to MongoDB");

  const auctionsCol: Collection<Auction> = client.db(DB_NAME).collection(
    TEST_MODE ? TEST_AUCTION_COLLECTION : AUCTIONS_COLLECTION
  );
  const itemsCol: Collection<AuctionItem> = client.db(DB_NAME).collection(
    TEST_MODE ? TEST_ITEMS_COLLECTION : ITEMS_COLLECTION
  );
  const artistsCol: Collection<Artist> = client.db(DB_NAME).collection(
    TEST_MODE ? TEST_ARTISTS_COLLECTION : ARTISTS_COLLECTION
  );

  if (TEST_MODE) {
    console.log(`🧪 TEST MODE — up to ${TEST_AUCTION_LIMIT} auctions, ${TEST_ITEM_LIMIT} items each, starting from AuctionID ${TEST_START_ID}`);
    console.log(`   Collections: '${TEST_AUCTION_COLLECTION}', '${TEST_ITEMS_COLLECTION}', '${TEST_ARTISTS_COLLECTION}'\n`);
  }

  // Find highest auctionId already stored
  const latest = await auctionsCol.find().sort({ auctionId: -1 }).limit(1).toArray();
  const startId = TEST_MODE ? TEST_START_ID : (latest.length > 0 ? latest[0].auctionId + 1 : FIRST_AUCTION_ID);
  console.log(`🔍 Starting from AuctionID ${startId}\n`);

  let misses = 0;
  let savedItems = 0;
  let savedAuctions = 0;
  let id = startId;

  // Skip over the known empty range
  if (id >= SKIP_RANGE_START && id <= SKIP_RANGE_END) {
    console.log(`⏭  Skipping empty ID range ${SKIP_RANGE_START}–${SKIP_RANGE_END}, jumping to ${SKIP_RANGE_END + 1}`);
    id = SKIP_RANGE_END + 1;
  }

  while (misses < MAX_MISSES) {
    if (savedAuctions >= RUN_LIMIT) {
      console.log(`\n🛑 Run limit of ${RUN_LIMIT} auctions reached — stopping. Run again to continue.`);
      break;
    }

    // Skip the empty range mid-run
    if (id >= SKIP_RANGE_START && id <= SKIP_RANGE_END) {
      console.log(`⏭  Skipping empty ID range, jumping from ${id} to ${SKIP_RANGE_END + 1}`);
      id = SKIP_RANGE_END + 1;
    }

    console.log(`\nFetching AuctionID ${id}...`);
    const result = await fetchAuction(id);

    if (result === null) {
      misses++;
      console.log(`  ✗ No valid completed auction (miss ${misses}/${MAX_MISSES})`);
    } else {
      misses = 0;
      const { auction, itemIds } = result;

      await auctionsCol.updateOne(
        { auctionId: id },
        { $set: auction },
        { upsert: true }
      );

      let itemsSavedThisAuction = 0;
      for (const itemId of itemIds) {
        if (TEST_MODE && itemsSavedThisAuction >= TEST_ITEM_LIMIT) {
          console.log(`    ⏭  Test item limit of ${TEST_ITEM_LIMIT} reached for this auction.`);
          break;
        }

        console.log(`  Fetching ItemID ${itemId}...`);
        const item = await fetchItem(id, itemId);

        if (item) {
          // Save or update artist
          if (item.artist) {
            const artistData = parseArtist(
              item.lifespan ? `${item.artist} (${item.lifespan})` : item.artist
            );
            const artistResult = await artistsCol.findOneAndUpdate(
              { name: artistData.name },
              { $set: artistData },
              { upsert: true, returnDocument: "after" }
            );
            item.artistId = artistResult?._id ?? null;
          }

          await itemsCol.updateOne(
            { itemId, scraperType: "vefuppbod" },
            { $set: item },
            { upsert: true }
          );
          if (DEBUG) console.log(`    ✓ Saved: "${item.title}" by ${item.artist}`);
          savedItems++;
          itemsSavedThisAuction++;
        } else {
          console.log(`    ✗ Could not parse item ${itemId}`);
        }

        await delay(DELAY_MS);
      }
    }

    id++;
    await delay(DELAY_MS);
  }

  console.log(`\n🏁 Done. Saved ${savedAuctions} auctions and ${savedItems} items.`);
  await client.close();
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});