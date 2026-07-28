// ============================================================
//  TSE Stock Tracker — Google Apps Script (complete)
//  Single deployment serves:
//    • The web app UI        (no action param)
//    • Portfolio CRUD        (?action=list|add|edit|delete|sell|sales)
//    • Yahoo Finance proxy   (google.script.run -> proxyYahoo / fetchAllPrices)
//
//  Deploy -> New deployment -> Web app
//    Execute as : Me
//    Who has access : Anyone
// ============================================================


// ─── Entry point ─────────────────────────────────────────────

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || "";

  // Serve HTML pages
  if (!action) {
    var page   = (e && e.parameter && e.parameter.page) || "portfolio";
    var valid  = ["portfolio", "growth", "history", "watchlist", "calendar"];
    if (valid.indexOf(page) === -1) page = "portfolio";
    var titles = {
      portfolio: "TSE Tracker",
      growth: "TSE Tracker - Growth",
      history: "TSE Tracker - History",
      watchlist: "TSE Tracker - Watchlist",
      calendar: "TSE Tracker - Calendar"
    };
    var file   = page === "portfolio" ? "index" : page;
    return HtmlService
      .createHtmlOutputFromFile(file)
      .setTitle(titles[page])
      .setSandboxMode(HtmlService.SandboxMode.IFRAME)
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  }

  if (action === "yahoo") return handleYahoo(e);

  try {
    if (action === "list")  return jsonOk(getAllPositions());
    if (action === "sales") return jsonOk(getAllSales());

    if (action === "add") {
      addPosition(JSON.parse(e.parameter.data));
      return jsonOk(getAllPositions());
    }
    if (action === "edit") {
      editPosition(parseInt(e.parameter.index, 10), JSON.parse(e.parameter.data));
      return jsonOk(getAllPositions());
    }
    if (action === "delete") {
      deletePosition(parseInt(e.parameter.index, 10));
      return jsonOk(getAllPositions());
    }
    if (action === "sell") {
      sellPosition(parseInt(e.parameter.index, 10), JSON.parse(e.parameter.data));
      return jsonOk(getAllPositions());
    }
    return jsonErr("Unknown action: " + action);
  } catch (err) {
    return jsonErr(err.message);
  }
}

function doPost(e) { return doGet(e); }

// Navigation helper -- returns the top-level /exec URL
// so the client can redirect window.top (the GAS iframe lives
// inside a frame; ?page= on the inner URL goes nowhere)
function getDeploymentUrl() {
  return ScriptApp.getService().getUrl();
}




// ─── Cache TTLs (seconds) ─────────────────────────────────────

var TTL_PRICE  = 300;    // current price (1d)   -> 5 min
var TTL_CHART  = 1800;   // chart history         -> 30 min
var TTL_SEARCH = 3600;   // name search           -> 1 hour


// ─── Yahoo Finance proxy (single URL) ────────────────────────

function handleYahoo(e) {
  var url = (e && e.parameter && e.parameter.url) || "";
  if (!url) return jsonErr("Missing url parameter");
  if (url.indexOf("query1.finance.yahoo.com") === -1 &&
      url.indexOf("query2.finance.yahoo.com") === -1) {
    return jsonErr("Blocked: only Yahoo Finance URLs allowed");
  }
  try {
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    });
    if (res.getResponseCode() !== 200) return jsonErr("Yahoo returned HTTP " + res.getResponseCode());
    return ContentService.createTextOutput(res.getContentText()).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return jsonErr(err.message);
  }
}


// ─── Client-callable: single cached Yahoo fetch ───────────────

function proxyYahoo(url) {
  if (!url) throw new Error("Missing url parameter");
  if (url.indexOf("query1.finance.yahoo.com") === -1 &&
      url.indexOf("query2.finance.yahoo.com") === -1) {
    throw new Error("Blocked: only Yahoo Finance URLs allowed");
  }

  var ttl = TTL_PRICE;
  if (url.indexOf("/finance/search") !== -1) {
    ttl = TTL_SEARCH;
  } else if (url.indexOf("range=1mo") !== -1 || url.indexOf("range=3mo") !== -1 ||
             url.indexOf("range=6mo") !== -1 || url.indexOf("range=1y")  !== -1) {
    ttl = TTL_CHART;
  }

  var cache = CacheService.getScriptCache();
  var key = "yf_" + Utilities.computeDigest(
    Utilities.DigestAlgorithm.MD5, url, Utilities.Charset.UTF_8
  ).map(function(b) { return ("0" + (b & 0xff).toString(16)).slice(-2); }).join("");

  var cached = cache.get(key);
  if (cached) return cached;

  var res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
  });
  if (res.getResponseCode() !== 200) throw new Error("Yahoo returned HTTP " + res.getResponseCode());

  var text = res.getContentText();
  if (text.length < 100000) {
    try { cache.put(key, text, ttl); } catch(e) {}
  }
  return text;
}


// ─── Client-callable: fetch ALL portfolio prices in one call ──
// Uses UrlFetchApp.fetchAll to avoid parallel google.script.run
// calls that trigger the bandwidth rate limit.

function fetchAllPrices(symbols) {
  if (!symbols || symbols.length === 0) return {};

  var cache = CacheService.getScriptCache();
  var results = {};
  var toFetch = [];

  symbols.forEach(function(sym) {
    var cached = cache.get("yf_price_" + sym);
    if (cached) {
      results[sym] = Number(cached);
    } else {
      toFetch.push(sym);
    }
  });

  if (toFetch.length > 0) {
    var requests = toFetch.map(function(sym) {
      return {
        url: "https://query1.finance.yahoo.com/v8/finance/chart/" + sym + "?interval=1d&range=1d",
        headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" },
        muteHttpExceptions: true
      };
    });

    var responses = UrlFetchApp.fetchAll(requests);
    responses.forEach(function(res, i) {
      var sym = toFetch[i];
      try {
        if (res.getResponseCode() === 200) {
          var data = JSON.parse(res.getContentText());
          var price = data.chart &&
                      data.chart.result &&
                      data.chart.result[0] &&
                      data.chart.result[0].meta &&
                      data.chart.result[0].meta.regularMarketPrice;
          if (price) {
            results[sym] = price;
            try { cache.put("yf_price_" + sym, String(price), TTL_PRICE); } catch(e) {}
          }
        }
      } catch(e) {}
    });
  }

  return results;
}


// ─── Sheet helpers ────────────────────────────────────────────

function getSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Sheet1") || ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(["symbol","name","buyPrice","buyDate","shares","notes","buyCount","tag"]);
  } else {
    // Migration: older sheets were created before the "tag" column existed.
    // Add the header if column 8 isn't already labeled "tag".
    var header = sheet.getRange(1, 8).getValue();
    if (header !== "tag") sheet.getRange(1, 8).setValue("tag");
  }
  return sheet;
}

function getSalesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Sales");
  if (!sheet) {
    sheet = ss.insertSheet("Sales");
    sheet.appendRow(["symbol","name","buyPrice","sellPrice","shares","buyDate","sellDate","profit"]);
  }
  return sheet;
}


// ─── Portfolio CRUD ───────────────────────────────────────────

function getAllPositions() {
  var sheet = getSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  return sheet.getRange(2, 1, lastRow - 1, 8).getValues().map(function(row) {
    return {
      symbol:   row[0] || "",
      name:     row[1] || "",
      buyPrice: Number(row[2]) || 0,
      buyDate:  row[3] ? formatDate(row[3]) : "",
      shares:   Number(row[4]) || 0,
      notes:    row[5] || "",
      buyCount: Number(row[6]) || 1,
      tag:      row[7] || ""
    };
  });
}

function addPosition(pos) {
  getSheet().appendRow([
    pos.symbol || "", pos.name || "", pos.buyPrice || 0,
    pos.buyDate || "", pos.shares || 0, pos.notes || "", pos.buyCount || 1, pos.tag || ""
  ]);
}

function editPosition(index, pos) {
  var sheet = getSheet();
  var row = index + 2;
  if (row < 2 || row > sheet.getLastRow()) throw new Error("Invalid index: " + index);
  sheet.getRange(row, 1, 1, 8).setValues([[
    pos.symbol || "", pos.name || "", pos.buyPrice || 0,
    pos.buyDate || "", pos.shares || 0, pos.notes || "", pos.buyCount || 1, pos.tag || ""
  ]]);
}

function deletePosition(index) {
  var sheet = getSheet();
  var row = index + 2;
  if (row < 2 || row > sheet.getLastRow()) throw new Error("Invalid index: " + index);
  sheet.deleteRow(row);
}

function getAllSales() {
  var sheet = getSalesSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  return sheet.getRange(2, 1, lastRow - 1, 8).getValues().map(function(row) {
    return {
      symbol:    row[0] || "",
      name:      row[1] || "",
      buyPrice:  Number(row[2]) || 0,
      sellPrice: Number(row[3]) || 0,
      shares:    Number(row[4]) || 0,
      buyDate:   row[5] ? formatDate(row[5]) : "",
      sellDate:  row[6] ? formatDate(row[6]) : "",
      profit:    Number(row[7]) || 0
    };
  });
}

function sellPosition(index, sellData) {
  var sheet = getSheet();
  var row = index + 2;
  if (row < 2 || row > sheet.getLastRow()) throw new Error("Invalid index: " + index);

  var values        = sheet.getRange(row, 1, 1, 6).getValues()[0];
  var symbol        = values[0];
  var name          = values[1];
  var buyPrice      = Number(values[2]);
  var buyDate       = values[3] ? formatDate(values[3]) : "";
  var currentShares = Number(values[4]);
  var sellShares    = Number(sellData.sellShares);
  var sellPrice     = Number(sellData.sellPrice);
  var sellDate      = sellData.sellDate || "";

  if (sellShares <= 0)            throw new Error("Sell shares must be positive");
  if (sellShares > currentShares) throw new Error("Cannot sell more than " + currentShares + " shares");

  var profit = (sellPrice - buyPrice) * sellShares;
  getSalesSheet().appendRow([symbol, name, buyPrice, sellPrice, sellShares, buyDate, sellDate, profit]);

  var remaining = currentShares - sellShares;
  if (remaining <= 0) {
    sheet.deleteRow(row);
  } else {
    sheet.getRange(row, 5).setValue(remaining);
  }
}


// ─── Client-callable wrappers ─────────────────────────────────

function addPositionFromClient(pos) {
  var existing = getAllPositions();
  var idx = -1;
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].symbol === pos.symbol) { idx = i; break; }
  }
  if (idx !== -1) {
    var e = existing[idx];
    var oldShares = Number(e.shares), oldPrice = Number(e.buyPrice);
    var newShares = Number(pos.shares), newPrice = Number(pos.buyPrice);
    var total = oldShares + newShares;
    editPosition(idx, {
      symbol:   e.symbol,
      name:     e.name,
      buyPrice: Math.round((oldShares * oldPrice + newShares * newPrice) / total * 10) / 10,
      buyDate:  pos.buyDate,
      shares:   total,
      notes:    pos.notes,
      buyCount: (Number(e.buyCount) || 1) + 1,
      tag:      pos.tag || e.tag || ""
    });
  } else {
    pos.buyCount = pos.buyCount || 1;
    addPosition(pos);
  }
  return getAllPositions();
}

function editPositionFromClient(index, pos) {
  editPosition(index, pos);
  return getAllPositions();
}

function deletePositionFromClient(index) {
  deletePosition(index);
  return getAllPositions();
}

function sellPositionFromClient(index, sellData) {
  sellPosition(index, sellData);
  return getAllPositions();
}




// ─── Portfolio Snapshots ──────────────────────────────────────
// getSnapshotSheet() creates the Snapshots sheet if missing.
// recordSnapshot() is meant to be called by a daily time trigger.
// getSnapshots() is called by the client to render the growth chart.
//
// HOW TO SET UP THE DAILY TRIGGER:
//   1. In Apps Script editor, click the clock icon (Triggers) on the left
//   2. Click "+ Add Trigger" (bottom right)
//   3. Choose function: recordSnapshot
//   4. Event source: Time-driven
//   5. Type: Day timer
//   6. Time: 4pm-5pm (after TSE closes at 3:30pm JST)
//   7. Save

function getSnapshotSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Snapshots");
  if (!sheet) {
    sheet = ss.insertSheet("Snapshots");
    sheet.appendRow(["date", "invested", "value", "unrealizedPL", "plPct", "positions"]);
    sheet.getRange(1, 1, 1, 6).setFontWeight("bold");
  }
  return sheet;
}

function recordSnapshot() {
  var positions = getAllPositions();
  if (positions.length === 0) return;

  var symbols = positions.map(function(p) { return p.symbol; });
  var priceMap = fetchAllPrices(symbols);

  var totalInvested = 0, totalValue = 0, validCount = 0;
  positions.forEach(function(pos) {
    var price = priceMap[pos.symbol];
    var invested = pos.buyPrice * pos.shares;
    totalInvested += invested;
    if (price) {
      totalValue += price * pos.shares;
      validCount++;
    } else {
      totalValue += invested; // fallback: use cost if price unavailable
    }
  });

  // Skip if we couldn't get any prices at all
  if (validCount === 0) return;

  var unrealizedPL = totalValue - totalInvested;
  var plPct = totalInvested > 0 ? Math.round((unrealizedPL / totalInvested) * 10000) / 100 : 0;
  var today = formatDate(new Date());

  var sheet = getSnapshotSheet();

  // Avoid duplicate entries for the same day
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    var lastDate = sheet.getRange(lastRow, 1).getValue();
    if (formatDate(lastDate) === today) {
      // Update existing row instead of adding a duplicate
      sheet.getRange(lastRow, 1, 1, 6).setValues([[
        today,
        Math.round(totalInvested),
        Math.round(totalValue),
        Math.round(unrealizedPL),
        plPct,
        positions.length
      ]]);
      return;
    }
  }

  sheet.appendRow([
    today,
    Math.round(totalInvested),
    Math.round(totalValue),
    Math.round(unrealizedPL),
    plPct,
    positions.length
  ]);
}

function getSnapshots() {
  var sheet = getSnapshotSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  return sheet.getRange(2, 1, lastRow - 1, 6).getValues().map(function(row) {
    return {
      date:        row[0] ? formatDate(row[0]) : "",
      invested:    Number(row[1]) || 0,
      value:       Number(row[2]) || 0,
      unrealizedPL: Number(row[3]) || 0,
      plPct:       Number(row[4]) || 0,
      positions:   Number(row[5]) || 0
    };
  }).filter(function(r) { return r.date !== ""; });
}

// Client callable — also lets the user manually trigger a snapshot
// from the UI (useful for the first day before the trigger fires)
function recordSnapshotFromClient() {
  recordSnapshot();
  return getSnapshots();
}

function getSnapshotsFromClient() {
  return getSnapshots();
}

// ─── Utilities ────────────────────────────────────────────────

function formatDate(value) {
  if (value instanceof Date) {
    var y = value.getFullYear();
    var m = ("0" + (value.getMonth() + 1)).slice(-2);
    var d = ("0" + value.getDate()).slice(-2);
    return y + "-" + m + "-" + d;
  }
  return String(value);
}

function jsonOk(data) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: true, data: data }))
    .setMimeType(ContentService.MimeType.JSON);
}

function jsonErr(msg) {
  return ContentService
    .createTextOutput(JSON.stringify({ success: false, error: msg }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
//  WATCHLIST ADD-ON — single clean copy
// ============================================================


// --- Watchlist sheet ---------------------------------------

function getWatchlistSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("Watchlist");
  if (!sheet) {
    sheet = ss.insertSheet("Watchlist");
    sheet.appendRow(["symbol", "name", "noticePrice", "noticeDate", "sector", "notes"]);
    sheet.getRange(1, 1, 1, 6).setFontWeight("bold");
  }
  return sheet;
}

function getAllWatchlist() {
  var sheet = getWatchlistSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  return sheet.getRange(2, 1, lastRow - 1, 6).getValues().map(function(row) {
    return {
      symbol:      row[0] || "",
      name:        row[1] || "",
      noticePrice: Number(row[2]) || 0,
      noticeDate:  row[3] ? formatDate(row[3]) : "",
      sector:      row[4] || "",
      notes:       row[5] || ""
    };
  });
}

function addWatchlistItem(item) {
  var sheet = getWatchlistSheet();
  var existing = getAllWatchlist();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].symbol === item.symbol) throw new Error(item.symbol + " is already on your watchlist");
  }
  var sector = getSector(item.symbol);
  sheet.appendRow([
    item.symbol || "",
    item.name || "",
    item.noticePrice || 0,
    item.noticeDate || formatDate(new Date()),
    sector || "",
    item.notes || ""
  ]);
  return getAllWatchlist();
}

function deleteWatchlistItem(index) {
  var sheet = getWatchlistSheet();
  var row = index + 2;
  if (row < 2 || row > sheet.getLastRow()) throw new Error("Invalid index: " + index);
  sheet.deleteRow(row);
  return getAllWatchlist();
}

function moveWatchlistToPortfolio(index, buyData) {
  var watchlist = getAllWatchlist();
  var item = watchlist[index];
  if (!item) throw new Error("Invalid watchlist index");
  addPositionFromClient({
    symbol:   item.symbol,
    name:     item.name,
    buyPrice: buyData.buyPrice,
    buyDate:  buyData.buyDate,
    shares:   buyData.shares,
    notes:    item.notes || ""
  });
  deleteWatchlistItem(index);
  return { watchlist: getAllWatchlist(), portfolio: getAllPositions() };
}


// --- Sector lookup (cached 6h) -------------------------------
// Shown as a small badge on each watchlist row.




// --- Weekly price history for watchlist ---------------------

function getWatchlistHistorySheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("WatchlistHistory");
  if (!sheet) {
    sheet = ss.insertSheet("WatchlistHistory");
    sheet.appendRow(["date", "symbol", "name", "price", "noticePrice", "changePct"]);
    sheet.getRange(1, 1, 1, 6).setFontWeight("bold");
  }
  return sheet;
}

// Attach to a weekly time trigger:
//   Apps Script editor -> Triggers -> + Add Trigger
//   Function: recordWatchlistPrices
//   Event source: Time-driven, Type: Week timer
//   Day of week: Monday, Time: 9am to 10am
function recordWatchlistPrices() {
  var watchlist = getAllWatchlist();
  if (watchlist.length === 0) return;

  var symbols = watchlist.map(function(w) { return w.symbol; });
  var priceMap = fetchAllPrices(symbols);
  var today = formatDate(new Date());
  var sheet = getWatchlistHistorySheet();

  watchlist.forEach(function(w) {
    var price = priceMap[w.symbol];
    if (!price) return;
    var changePct = w.noticePrice > 0 ? Math.round(((price - w.noticePrice) / w.noticePrice) * 10000) / 100 : 0;
    sheet.appendRow([today, w.symbol, w.name, price, w.noticePrice, changePct]);
  });
}

function getWatchlistHistory() {
  var sheet = getWatchlistHistorySheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  return sheet.getRange(2, 1, lastRow - 1, 6).getValues().map(function(row) {
    return {
      date:        row[0] ? formatDate(row[0]) : "",
      symbol:      row[1] || "",
      name:        row[2] || "",
      price:       Number(row[3]) || 0,
      noticePrice: Number(row[4]) || 0,
      changePct:   Number(row[5]) || 0
    };
  });
}


// --- Yahoo quote helper (Add-to-watchlist name lookup) -------

function fetchYahooQuote(symbol) {
  var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + symbol + "?interval=1d&range=1d";
  try {
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    });
    if (res.getResponseCode() !== 200) return { name: symbol };
    var data = JSON.parse(res.getContentText());
    var meta = data.chart && data.chart.result && data.chart.result[0] && data.chart.result[0].meta;
    var name = meta ? (meta.longName || meta.shortName || symbol) : symbol;
    return { name: name };
  } catch (e) {
    return { name: symbol };
  }
}


// --- Client-callable wrappers --------------------------------

function getAllWatchlistFromClient()          { return getAllWatchlist(); }
function addWatchlistItemFromClient(item)      { return addWatchlistItem(item); }
function deleteWatchlistItemFromClient(index)  { return deleteWatchlistItem(index); }
function moveToPortfolioFromClient(index, buy) { return moveWatchlistToPortfolio(index, buy); }
function getWatchlistHistoryFromClient()       { return getWatchlistHistory(); }
function recordWatchlistPricesFromClient()     { recordWatchlistPrices(); return getWatchlistHistory(); }

// ============================================================
//  KEY DATES ADD-ON — earnings / dividend / 優待 / custom dates
//  Appends to Code.gs. Requires:
//    - "calendar" added to doGet's `valid` page list and `titles` map
//    - a Calendar nav link added to index/growth/history/watchlist.html
//    - calendar.html added as a project file
//
//  AUTOMATIC WEEKLY FETCH:
//    Apps Script editor -> Triggers -> + Add Trigger
//    Function: fetchKeyDatesForPortfolio
//    Event source: Time-driven, Type: Week timer
//    Day of week: Monday, Time: 6am to 7am
//  (Runs before recordWatchlistPrices so both weekly jobs stay together.)
// ============================================================


// --- KeyDates sheet -------------------------------------------

function getKeyDatesSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("KeyDates");
  if (!sheet) {
    sheet = ss.insertSheet("KeyDates");
    sheet.appendRow(["symbol", "name", "eventType", "date", "note", "source", "calendarEventId"]);
    sheet.getRange(1, 1, 1, 7).setFontWeight("bold");
  }
  return sheet;
}

// eventType values: "earnings", "dividend", "exdividend", "yutai", "custom"
// source values: "auto" (from weekly Yahoo fetch) or "manual" (user-entered)

function getAllKeyDates() {
  var sheet = getKeyDatesSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return [];
  return sheet.getRange(2, 1, lastRow - 1, 7).getValues().map(function(row) {
    return {
      symbol:          row[0] || "",
      name:            row[1] || "",
      eventType:       row[2] || "custom",
      date:            row[3] ? formatDate(row[3]) : "",
      note:            row[4] || "",
      source:          row[5] || "manual",
      calendarEventId: row[6] || ""
    };
  }).filter(function(r) { return r.date !== ""; });
}

function addKeyDate(item) {
  var sheet = getKeyDatesSheet();
  var calendarEventId = "";
  if (item.pushToCalendar) {
    calendarEventId = createCalendarEventForKeyDate(item.symbol, item.name, item.eventType, item.date, item.note);
  }
  sheet.appendRow([
    item.symbol || "",
    item.name || "",
    item.eventType || "custom",
    item.date || "",
    item.note || "",
    item.source || "manual",
    calendarEventId
  ]);
  return getAllKeyDates();
}

function deleteKeyDate(index) {
  var sheet = getKeyDatesSheet();
  var row = index + 2;
  if (row < 2 || row > sheet.getLastRow()) throw new Error("Invalid index: " + index);

  // Also remove the linked Google Calendar event, if any
  var calId = sheet.getRange(row, 7).getValue();
  if (calId) {
    try {
      var ev = CalendarApp.getDefaultCalendar().getEventById(calId);
      if (ev) ev.deleteEvent();
    } catch (e) {}
  }
  sheet.deleteRow(row);
  return getAllKeyDates();
}

function pushKeyDateToCalendar(index) {
  var sheet = getKeyDatesSheet();
  var row = index + 2;
  if (row < 2 || row > sheet.getLastRow()) throw new Error("Invalid index: " + index);
  var values = sheet.getRange(row, 1, 1, 7).getValues()[0];
  if (values[6]) throw new Error("Already on Google Calendar");
  var calendarEventId = createCalendarEventForKeyDate(values[0], values[1], values[2], formatDate(values[3]), values[4]);
  sheet.getRange(row, 7).setValue(calendarEventId);
  return getAllKeyDates();
}

function createCalendarEventForKeyDate(symbol, name, eventType, dateStr, note) {
  var labels = { earnings: "\uD83D\uDCCA Earnings", dividend: "\uD83D\uDCB0 Dividend", exdividend: "\uD83D\uDCB0 Ex-Dividend", yutai: "\uD83C\uDF81 \u512A\u5F85", custom: "\uD83D\uDCCC" };
  var title = (labels[eventType] || "\uD83D\uDCCC") + " " + (name || symbol) + " (" + symbol + ")";
  var date = new Date(dateStr + "T00:00:00");
  var event = CalendarApp.getDefaultCalendar().createAllDayEvent(title, date, { description: note || "" });
  return event.getId();
}


// --- Automatic weekly fetch from Yahoo Finance -----------------
// Pulls upcoming earnings + dividend dates for everything currently
// in your portfolio, and upserts them into KeyDates as source="auto".
// 優待 (yutai) dates aren't reliably exposed by Yahoo, so those still
// need to be added manually.

function fetchKeyDatesForPortfolio() {
  var positions = getAllPositions();
  if (positions.length === 0) return getAllKeyDates();

  var existing = getAllKeyDates();

  positions.forEach(function(pos) {
    var events = fetchYahooCalendarEvents(pos.symbol);
    events.forEach(function(ev) {
      upsertAutoKeyDate(pos.symbol, pos.name, ev.eventType, ev.date, existing);
    });
    Utilities.sleep(150); // be polite to Yahoo between symbols
  });

  return getAllKeyDates();
}



// Adds an auto-fetched date only if it's not already present for the
// same symbol/eventType/date (avoids re-adding duplicates each week).
function upsertAutoKeyDate(symbol, name, eventType, dateStr, existingList) {
  if (!dateStr) return;
  var dup = existingList.some(function(k) {
    return k.symbol === symbol && k.eventType === eventType && k.date === dateStr;
  });
  if (dup) return;

  // Also drop stale auto entries of the same type for this symbol
  // (e.g. last week's earnings estimate got pushed back a date)
  removeStaleAutoKeyDates(symbol, eventType, dateStr);

  var sheet = getKeyDatesSheet();
  sheet.appendRow([symbol, name, eventType, dateStr, "", "auto", ""]);
  existingList.push({ symbol: symbol, name: name, eventType: eventType, date: dateStr, note: "", source: "auto", calendarEventId: "" });
}

function removeStaleAutoKeyDates(symbol, eventType, newDate) {
  var sheet = getKeyDatesSheet();
  var lastRow = sheet.getLastRow();
  if (lastRow <= 1) return;
  var data = sheet.getRange(2, 1, lastRow - 1, 7).getValues();
  // Walk bottom-up so row deletion doesn't shift indices we still need
  for (var i = data.length - 1; i >= 0; i--) {
    var row = data[i];
    var rSymbol = row[0], rType = row[2], rDate = row[3] ? formatDate(row[3]) : "", rSource = row[5];
    if (rSymbol === symbol && rType === eventType && rSource === "auto" && rDate !== newDate) {
      var todayStr = formatDate(new Date());
      if (rDate >= todayStr) { // only clear future stale estimates, keep past history
        var calId = row[6];
        if (calId) {
          try { var ev = CalendarApp.getDefaultCalendar().getEventById(calId); if (ev) ev.deleteEvent(); } catch (e) {}
        }
        sheet.deleteRow(i + 2);
      }
    }
  }
}

// ============================================================
//  YAHOO CRUMB/SESSION FIX
//  Replaces fetchYahooCalendarEvents() and adds getYahooSession().
//  Also fixes getSector() the same way, since it hits the same
//  quoteSummary endpoint and will hit the same 401 eventually
//  (Yahoo is rolling this requirement out gradually per-endpoint).
//
//  HOW TO APPLY:
//  1. In Code.gs, DELETE the existing fetchYahooCalendarEvents()
//     function and getSector() function.
//  2. Paste this whole block in their place.
//  3. Run debugKeyDatesFetch once manually to confirm it now
//     returns HTTP 200 with real calendarEvents data.
// ============================================================


// --- Session (cookie + crumb) handling --------------------------
// Yahoo's quoteSummary endpoint requires a valid session cookie and
// a matching "crumb" token, obtained by:
//   1. Hitting fc.yahoo.com to get a session cookie
//   2. Using that cookie to request a crumb from
//      query1.finance.yahoo.com/v1/test/getcrumb
// Both are cached together for ~50 minutes (crumbs are session-based
// and can expire/rotate; 50 min keeps us safely under an hour).

function getYahooSession() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get("yf_session");
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }

  var session = fetchFreshYahooSession();
  if (session) {
    try { cache.put("yf_session", JSON.stringify(session), 3000); } catch (e) {} // ~50 min
  }
  return session;
}

function fetchFreshYahooSession() {
  var ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

  // Step 1: get a session cookie
  var cookieRes = UrlFetchApp.fetch("https://fc.yahoo.com", {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { "User-Agent": ua }
  });
  var cookieHeader = extractCookieHeader(cookieRes);
  if (!cookieHeader) return null;

  // Step 2: use the cookie to fetch a crumb
  var crumbRes = UrlFetchApp.fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
    muteHttpExceptions: true,
    headers: { "User-Agent": ua, "Cookie": cookieHeader }
  });
  if (crumbRes.getResponseCode() !== 200) return null;
  var crumb = crumbRes.getContentText().trim();
  if (!crumb || crumb.indexOf("<") !== -1) return null; // sanity check, not an HTML error page

  return { cookie: cookieHeader, crumb: crumb, ua: ua };
}

// UrlFetchApp responses expose Set-Cookie via getAllHeaders(); this can
// be a single string or an array depending on how many cookies were set.
function extractCookieHeader(res) {
  var headers = res.getAllHeaders();
  var raw = headers["Set-Cookie"] || headers["set-cookie"];
  if (!raw) return null;
  var list = Array.isArray(raw) ? raw : [raw];
  var pairs = list.map(function(c) { return c.split(";")[0]; });
  return pairs.join("; ");
}


// --- calendarEvents fetch, now with crumb ------------------------

function fetchYahooCalendarEvents(symbol) {
  var results = [];
  var session = getYahooSession();
  if (!session) return results; // couldn't establish a session; skip quietly

  var url = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/" + symbol
          + "?modules=calendarEvents&crumb=" + encodeURIComponent(session.crumb);

  try {
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { "User-Agent": session.ua, "Accept": "application/json", "Cookie": session.cookie }
    });

    // If the crumb went stale, refresh once and retry
    if (res.getResponseCode() === 401) {
      CacheService.getScriptCache().remove("yf_session");
      session = getYahooSession();
      if (!session) return results;
      url = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/" + symbol
          + "?modules=calendarEvents&crumb=" + encodeURIComponent(session.crumb);
      res = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        headers: { "User-Agent": session.ua, "Accept": "application/json", "Cookie": session.cookie }
      });
    }

    if (res.getResponseCode() !== 200) return results;
    var data = JSON.parse(res.getContentText());
    var ce = data.quoteSummary &&
             data.quoteSummary.result &&
             data.quoteSummary.result[0] &&
             data.quoteSummary.result[0].calendarEvents;
    if (!ce) return results;

    if (ce.earnings && ce.earnings.earningsDate && ce.earnings.earningsDate.length > 0) {
      var raw = ce.earnings.earningsDate[0].raw;
      if (raw) results.push({ eventType: "earnings", date: formatDate(new Date(raw * 1000)) });
    }
    if (ce.exDividendDate && ce.exDividendDate.raw) {
      results.push({ eventType: "exdividend", date: formatDate(new Date(ce.exDividendDate.raw * 1000)) });
    }
    if (ce.dividendDate && ce.dividendDate.raw) {
      results.push({ eventType: "dividend", date: formatDate(new Date(ce.dividendDate.raw * 1000)) });
    }
  } catch (e) {}
  return results;
}


// --- getSector, same fix applied (also hits quoteSummary) --------

function getSector(symbol) {
  var cache = CacheService.getScriptCache();
  var key = "sector_" + symbol;
  var cached = cache.get(key);
  if (cached) return cached;

  var session = getYahooSession();
  if (!session) return "";

  try {
    var url = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/" + symbol
            + "?modules=assetProfile&crumb=" + encodeURIComponent(session.crumb);
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      headers: { "User-Agent": session.ua, "Accept": "application/json", "Cookie": session.cookie }
    });

    if (res.getResponseCode() === 401) {
      CacheService.getScriptCache().remove("yf_session");
      session = getYahooSession();
      if (!session) return "";
      url = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/" + symbol
          + "?modules=assetProfile&crumb=" + encodeURIComponent(session.crumb);
      res = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        headers: { "User-Agent": session.ua, "Accept": "application/json", "Cookie": session.cookie }
      });
    }

    if (res.getResponseCode() !== 200) return "";
    var data = JSON.parse(res.getContentText());
    var profile = data.quoteSummary &&
                  data.quoteSummary.result &&
                  data.quoteSummary.result[0] &&
                  data.quoteSummary.result[0].assetProfile;
    var sector = (profile && profile.sector) || "";
    if (sector) cache.put(key, sector, 21600);
    return sector;
  } catch (e) {
    return "";
  }
}


// --- Updated debug helper (tests the crumb path directly) --------

function debugKeyDatesFetch(symbol) {
  symbol = symbol || "7203.T";
  var session = getYahooSession();
  Logger.log("Symbol: " + symbol);
  if (!session) {
    Logger.log("--> Could not establish a Yahoo session (cookie/crumb fetch failed).");
    return { symbol: symbol, sessionOk: false };
  }
  Logger.log("Session OK. Crumb: " + session.crumb);

  var url = "https://query1.finance.yahoo.com/v10/finance/quoteSummary/" + symbol
          + "?modules=calendarEvents&crumb=" + encodeURIComponent(session.crumb);
  var res = UrlFetchApp.fetch(url, {
    muteHttpExceptions: true,
    headers: { "User-Agent": session.ua, "Accept": "application/json", "Cookie": session.cookie }
  });
  var code = res.getResponseCode();
  var text = res.getContentText();
  Logger.log("HTTP status: " + code);
  Logger.log("Raw response (first 1500 chars): " + text.substring(0, 1500));

  if (code !== 200) return { symbol: symbol, httpStatus: code, raw: text.substring(0, 1500) };

  try {
    var data = JSON.parse(text);
    var ce = data.quoteSummary &&
             data.quoteSummary.result &&
             data.quoteSummary.result[0] &&
             data.quoteSummary.result[0].calendarEvents;
    Logger.log("calendarEvents object: " + JSON.stringify(ce));
    return { symbol: symbol, httpStatus: code, calendarEvents: ce };
  } catch (e) {
    Logger.log("--> Failed to parse JSON: " + e.message);
    return { symbol: symbol, httpStatus: code, parseError: e.message };
  }
}

function debugKeyDatesFetchAll() {
  var positions = getAllPositions();
  var out = positions.map(function(p) {
    Logger.log("=== " + p.symbol + " (" + p.name + ") ===");
    return debugKeyDatesFetch(p.symbol);
  });
  return out;
}

// --- Client-callable wrappers -----------------------------------

function getAllKeyDatesFromClient()              { return getAllKeyDates(); }
function addKeyDateFromClient(item)               { return addKeyDate(item); }
function deleteKeyDateFromClient(index)           { return deleteKeyDate(index); }
function pushKeyDateToCalendarFromClient(index)   { return pushKeyDateToCalendar(index); }
function fetchKeyDatesForPortfolioFromClient()    { return fetchKeyDatesForPortfolio(); }

function clearYahooSession() {
  CacheService.getScriptCache().remove("yf_session");
}


// --- Portfolio sector lookup (for concentration warning) --------
// Reuses the same cached getSector() the watchlist already uses.

function getPortfolioSectors(symbols) {
  var results = {};
  symbols.forEach(function(sym) {
    results[sym] = getSector(sym); // getSector() already caches 6h per symbol
    Utilities.sleep(80); // be polite to Yahoo between symbols not already cached
  });
  return results;
}

function getPortfolioSectorsFromClient(symbols) {
  return getPortfolioSectors(symbols);
}