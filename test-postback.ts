import "dotenv/config";
import axios from "axios";
import * as cheerio from "cheerio";

const PAGE_URL = "https://www.myndlist.is/auction/AuctionResult.aspx";

async function testPostback() {
  console.log(`\n1. Fetching page to extract ASP.NET form state...`);

  const getRes = await axios.get(PAGE_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; research-bot/1.0)" },
  });

  const $ = cheerio.load(getRes.data);
  const rawHtml = getRes.data as string;

  const viewState = $("#__VIEWSTATE").val() as string;
  const viewStateGenerator = $("#__VIEWSTATEGENERATOR").val() as string;
  const eventValidation = $("#__EVENTVALIDATION").val() as string;

  console.log(`   __VIEWSTATE length: ${viewState?.length ?? 0}`);
  console.log(`   __VIEWSTATEGENERATOR: ${viewStateGenerator}`);
  console.log(`   __EVENTVALIDATION length: ${eventValidation?.length ?? 0}`);

  // Check all links containing Uppboð
  console.log(`\n2. All links containing 'Uppboð':`);
  $("a").each((_, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr("href") ?? "";
    const onclick = $(el).attr("onclick") ?? "";
    if (text.includes("Uppboð") || href.includes("Uppboð") || onclick.includes("Uppboð")) {
      console.log(`   text="${text}" href="${href}" onclick="${onclick}"`);
    }
  });

  // Check all elements with onclick containing __doPostBack
  console.log(`\n3. All elements with __doPostBack in onclick:`);
  $("[onclick*='__doPostBack']").each((_, el) => {
    const text = $(el).text().trim();
    const onclick = $(el).attr("onclick") ?? "";
    console.log(`   tag=${el.tagName} text="${text}" onclick="${onclick}"`);
  });

  // Check all elements with href containing __doPostBack
  console.log(`\n4. All elements with __doPostBack in href:`);
  $("[href*='__doPostBack']").each((_, el) => {
    const text = $(el).text().trim();
    const href = $(el).attr("href") ?? "";
    console.log(`   tag=${el.tagName} text="${text}" href="${href}"`);
  });

  // Print raw HTML snippets containing "Uppboð nr"
  console.log(`\n5. Raw HTML snippets containing 'Uppboð nr':`);
  const matches = rawHtml.match(/.{0,150}Uppboð nr.{0,150}/g);
  matches?.forEach(m => console.log(`   ${m.trim()}`));

  console.log(`\nDone scanning.`);
}

testPostback().catch(console.error);