import "dotenv/config";
import * as cheerio from "cheerio";
import { MongoClient, Collection, ObjectId } from "mongodb";
import { chromium } from "playwright";

// ── Config ────────────────────────────────────────────────────────────────────
const MONGO_URI = process.env.MONGODB_URI!;
const DB_NAME = "myndlist";
const AUCTIONS_COLLECTION = "auctions";
const ITEMS_COLLECTION = "auction_items";
const ARTISTS_COLLECTION = "artists";

const RESULTS_URL = "https://www.myndlist.is/auction/AuctionResult.aspx";
const ITEM_BASE_URL = "https://www.myndlist.is/auction/AuctionItemDetails.aspx?ItemID=";
const DELAY_MS = 1000;

const TEST_MODE = process.env.TEST_MODE === "true";
const TEST_ITEM_LIMIT = 5;
const TEST_AUCTION_COLLECTION = "auctions_test";
const TEST_ITEMS_COLLECTION = "auction_items_test";
const TEST_ARTISTS_COLLECTION = "artists_test";

// ── Types ─────────────────────────────────────────────────────────────────────
interface Artist {
  name: string;
  alias: string | null;
  yearBorn: number | null;
  yearDied: number | null;
  scrapedAt: Date;
}

interface Auction {
  auctionId: string;
  auctionNumber: string;
  name: string;
  auctionDate: Date | null;
  totalItems: number;
  type: "uppbod";
  scrapedAt: Date;
  sourceUrl: string;
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

function parseInlineItem(auctionId: string, itemId: number, linkText: string, detailText: string): AuctionItem {
  // ── Item number & artist ───────────────────────────────────────────────────
  const nrMatch = linkText.match(/Nr\.(\d+)\s*[-–]\s*(.+)/);
  const itemNumber = nrMatch?.[1]?.trim() ?? null;
  const artistRaw = nrMatch?.[2]?.trim() ?? null;
  const yearsMatch = artistRaw?.match(/\((\d{4}(?:[-–]\d{4})?)\)\s*$/);
  const lifespan = yearsMatch?.[1]?.trim() ?? null;
  const artist = artistRaw?.replace(/\s*\(\d{4}(?:[-–]\d{4})?\)\s*$/, "").trim() ?? null;

  // ── Detail line ────────────────────────────────────────────────────────────
  const parts = detailText.split(/\s*[-–]\s*/);
  const title = parts[0]?.trim() ?? null;

  let medium: string | null = null;
  let year: string | null = null;
  let cmWidth: number | null = null;
  let cmHeight: number | null = null;
  let signed: boolean | null = null;

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

  // ── Estimate ───────────────────────────────────────────────────────────────
  const estRangeMatch = detailText.match(/Verðmat:\s*([\d.,]+)\s*[-–]\s*([\d.,]+)/);
  const estSingleMatch = detailText.match(/Verðmat:\s*([\d.,]+)/);
  const estimateMin = estRangeMatch ? parseAmount(estRangeMatch[1]) : null;
  const estimateMax = estRangeMatch ? parseAmount(estRangeMatch[2]) : (estSingleMatch ? parseAmount(estSingleMatch[1]) : null);

  // ── Hammer price ───────────────────────────────────────────────────────────
  const hammerMatch = detailText.match(/Hamarshögg:\s*([\d.,]+)/);
  const hammerPrice = hammerMatch ? parseAmount(hammerMatch[1]) : null;

  return {
    auctionId,
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
    hammerPrice,
    cmWidth,
    cmHeight,
    signed,
    imageUrl: null,
    scrapedAt: new Date(),
    sourceUrl: `${ITEM_BASE_URL}${itemId}`,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!MONGO_URI) throw new Error("MONGODB_URI is not set.");

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

  if (TEST_MODE) console.log(`🧪 TEST MODE — first tab only, max ${TEST_ITEM_LIMIT} items\n`);

  // Find already scraped auction numbers
  const scraped = await auctionsCol.find({ type: "uppbod" }).toArray();
  const scrapedNumbers = new Set(scraped.map(a => a.auctionNumber));
  console.log(`Already scraped ${scrapedNumbers.size} physical auctions\n`);

  // Launch Playwright
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  console.log(`Loading ${RESULTS_URL}...`);
  await page.goto(RESULTS_URL, { waitUntil: "networkidle" });

  // Find all Uppboð tabs (not Vefuppboð)
  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a"))
      .filter(el => /^Uppboð nr\.\s*\d+$/.test(el.textContent?.trim() ?? ""))
      .map(el => ({ text: el.textContent?.trim() ?? "", href: el.getAttribute("href") ?? "" }))
  );

  console.log(`Found ${tabs.length} Uppboð tabs: ${tabs.map(t => t.text).join(", ")}\n`);

  if (tabs.length === 0) {
    console.log("❌ No tabs found. Printing all links on page for debugging:");
    const allLinks = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a"))
        .map(el => el.textContent?.trim())
        .filter(Boolean)
    );
    allLinks.forEach(l => console.log(`   "${l}"`));
    await browser.close();
    await client.close();
    return;
  }

  let savedAuctions = 0;
  let savedItems = 0;

  for (const tab of tabs) {
    const numMatch = tab.text.match(/Uppboð nr\.\s*(\d+)/);
    const auctionNumber = numMatch?.[1] ?? null;
    if (!auctionNumber) continue;

    if (scrapedNumbers.has(auctionNumber)) {
      console.log(`⏭  Skipping ${tab.text} — already scraped`);
      continue;
    }

    console.log(`\nClicking tab: ${tab.text}`);
    await page.locator("a").filter({ hasText: tab.text }).first().click();
    await page.waitForTimeout(2000);

    // Get rendered HTML
    const html = await page.content();
    const $ = cheerio.load(html);

    const auctionId = `uppbod-${auctionNumber}`;
    const headingEl = $("h2").filter((_, el) => $(el).text().includes(`Uppboð nr. ${auctionNumber}`)).first();
    const headingText = headingEl.text().trim();
    const dateMatch = headingText.match(/(\d{1,2}\.\d{1,2}\.\d{4})/);
    const auctionDate = dateMatch ? new Date(dateMatch[1].split(".").reverse().join("-")) : null;

    console.log(`  📋 ${headingText}`);

    // Extract items
    const itemLinks = $("a[href*='AuctionItemDetails.aspx?ItemID=']");
    const items: AuctionItem[] = [];

    itemLinks.each((_, el) => {
      const href = $(el).attr("href") ?? "";
      const itemIdMatch = href.match(/ItemID=(\d+)/);
      if (!itemIdMatch) return;
      const itemId = parseInt(itemIdMatch[1], 10);
      const linkText = $(el).text().trim();
      const cell = $(el).closest("td");
      const cellText = cell.text().replace(linkText, "").trim();
      const detailLine = cellText.split("\n").map((l: string) => l.trim()).filter(Boolean).join(" ");
      const fullText = `${linkText}\n${detailLine}`;
      items.push(parseInlineItem(auctionId, itemId, linkText, fullText));
    });

    // Save auction
    const auction: Auction = {
      auctionId,
      auctionNumber,
      name: `Uppboð nr. ${auctionNumber}`,
      auctionDate,
      totalItems: items.length,
      type: "uppbod",
      scrapedAt: new Date(),
      sourceUrl: RESULTS_URL,
    };

    await auctionsCol.updateOne({ auctionId }, { $set: auction }, { upsert: true });
    savedAuctions++;
    console.log(`  ✓ Auction saved: "${auction.name}" | ${auctionDate?.toDateString() ?? "?"} | ${items.length} items`);

    // Save items
    let savedThisAuction = 0;
    for (const item of items) {
      if (TEST_MODE && savedThisAuction >= TEST_ITEM_LIMIT) {
        console.log(`    ⏭  Test item limit of ${TEST_ITEM_LIMIT} reached.`);
        break;
      }

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

      await itemsCol.updateOne({ itemId: item.itemId, scraperType: "uppbod" }, { $set: item }, { upsert: true });
      savedItems++;
      savedThisAuction++;
      console.log(`    ✓ ${item.itemNumber}: "${item.title}" by ${item.artist} — hammer: ${item.hammerPrice ?? "n/a"}`);

      await delay(DELAY_MS);
    }

    if (TEST_MODE) {
      console.log("\n🧪 TEST MODE — stopping after first auction tab.");
      break;
    }
  }

  await browser.close();
  await client.close();
  console.log(`\n🏁 Done. Saved ${savedAuctions} auctions and ${savedItems} items.`);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});