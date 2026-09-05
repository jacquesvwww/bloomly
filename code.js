/**
 * Bloomly Coffee Tracker — Core Backend Logic (Updated)
 * Handles Google Sheets CRUD, multi-user tagging, brew time in M:SS, dynamic averages.
 */

function doGet() {
    return HtmlService.createTemplateFromFile('Index')
      .evaluate()
      .setTitle('Bloomly Coffee Hub')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  // ─── USERS / AUTH ────────────────────────────────────────────────────────────

  function getUsersSheet() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Users");
    if (!sheet) {
      sheet = ss.insertSheet("Users");
      sheet.appendRow(["Name", "Email", "PasswordHash", "Salt", "CreatedAt"]);
    }
    return sheet;
  }

  function generateSalt_() {
    return Utilities.getUuid();
  }

  function hashPassword_(password, salt) {
    var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, password + salt);
    return Utilities.base64Encode(digest);
  }

  function findUserRowByEmail_(sheet, email) {
    var data = sheet.getDataRange().getValues();
    var targetEmail = email ? email.toString().trim().toLowerCase() : "";
    for (var i = 1; i < data.length; i++) {
      if (data[i][1] && data[i][1].toString().trim().toLowerCase() === targetEmail) {
        return { rowIndex: i + 1, row: data[i] };
      }
    }
    return null;
  }

  /**
   * Creates a new user profile. payload: { name, email, password }
   */
  function registerUser(payload) {
    var name = (payload && payload.name || "").trim();
    var email = (payload && payload.email || "").trim();
    var password = (payload && payload.password || "");

    if (!name || !email || !password) {
      return { success: false, message: "Name, email and password are all required." };
    }

    var sheet = getUsersSheet();
    if (findUserRowByEmail_(sheet, email)) {
      return { success: false, message: "An account with that email already exists." };
    }

    var salt = generateSalt_();
    var hash = hashPassword_(password, salt);
    sheet.appendRow([name, email, hash, salt, new Date()]);

    return { success: true, name: name, email: email };
  }

  /**
   * Verifies credentials. payload: { email, password }
   */
  function loginUser(payload) {
    var email = (payload && payload.email || "").trim();
    var password = (payload && payload.password || "");

    if (!email || !password) {
      return { success: false, message: "Enter your email and password." };
    }

    var sheet = getUsersSheet();
    var match = findUserRowByEmail_(sheet, email);
    if (!match) {
      return { success: false, message: "No account found for that email." };
    }

    if (hashPassword_(password, match.row[3]) !== match.row[2]) {
      return { success: false, message: "Incorrect password." };
    }

    return { success: true, name: match.row[0], email: match.row[1] };
  }

  /**
   * Updates a user's name, email and/or password.
   * payload: { currentEmail, name, email, currentPassword, newPassword }
   * If newPassword is set, currentPassword must match the stored password.
   * Renaming a profile also relabels their historical brew log rows so
   * brew history keeps matching the account after a name change.
   */
  function updateUserProfile(payload) {
    var currentEmail = (payload && payload.currentEmail || "").trim();
    var newName = (payload && payload.name || "").trim();
    var newEmail = (payload && payload.email || "").trim();
    var currentPassword = (payload && payload.currentPassword || "");
    var newPassword = (payload && payload.newPassword || "");

    if (!currentEmail || !newName || !newEmail) {
      return { success: false, message: "Name and email are required." };
    }

    var sheet = getUsersSheet();
    var match = findUserRowByEmail_(sheet, currentEmail);
    if (!match) {
      return { success: false, message: "Account not found." };
    }

    var oldName = match.row[0];
    var oldEmail = match.row[1].toString().trim().toLowerCase();

    if (newEmail.toLowerCase() !== oldEmail) {
      var clash = findUserRowByEmail_(sheet, newEmail);
      if (clash) {
        return { success: false, message: "That email is already in use by another account." };
      }
    }

    var hashToSave = match.row[2];
    var saltToSave = match.row[3];
    if (newPassword) {
      if (!currentPassword || hashPassword_(currentPassword, match.row[3]) !== match.row[2]) {
        return { success: false, message: "Current password is incorrect." };
      }
      saltToSave = generateSalt_();
      hashToSave = hashPassword_(newPassword, saltToSave);
    }

    sheet.getRange(match.rowIndex, 1, 1, 4).setValues([[newName, newEmail, hashToSave, saltToSave]]);

    if (newName !== oldName) {
      renameBrewLogUser_(oldName, newName);
    }

    return { success: true, name: newName, email: newEmail };
  }

  /**
   * Relabels every brew log row tagged with oldName (column P) to newName,
   * so a profile rename doesn't orphan past brew history.
   */
  function renameBrewLogUser_(oldName, newName) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Brews");
    if (!sheet) return;

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return;

    var range = sheet.getRange(2, 16, lastRow - 1, 1); // Column P
    var values = range.getValues();
    var targetOld = oldName ? oldName.toString().trim().toLowerCase() : "";
    var changed = false;

    for (var i = 0; i < values.length; i++) {
      var cell = values[i][0];
      if (cell && cell.toString().trim().toLowerCase() === targetOld) {
        values[i][0] = newName;
        changed = true;
      }
    }

    if (changed) range.setValues(values);
  }

  /**
   * Compiles aggregated stats and frequency counts for the main dashboard view.
   * Filters by userContext (column P / index 15).
   */
  function getDashboardData(userContext) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Brews");
    if (!sheet) return buildEmptyDashboard();

    var data = sheet.getDataRange().getValues();
    if (data.length <= 1) return buildEmptyDashboard();

    var targetUser = userContext ? userContext.trim().toLowerCase() : "jacques";

    var totalBrews = 0;
    var methodFrequencyMap = {};
    var coffeeFrequencyMap = {};
    var totalBrewSecondsSum = 0;
    var validBrewSecondsCount = 0;
    var allUniqueCoffeesMap = {};
    var mostRecentCoffeeName = "--";
    var lastBrewedByCoffee = {};
    var lastUsedByGrinder = {};

    // Collect all unique recipes from the Recipes sheet
    var savedRecipes = getRecipes().map(function(r) { return r.name; });
    var baseLibrary = getBaseLibrary();

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var rowUser = row[15] ? row[15].toString().trim().toLowerCase() : "";

      if (rowUser === targetUser) {
        totalBrews++;
        mostRecentCoffeeName = row[1] ? row[1].toString() : mostRecentCoffeeName;

        var coffeeName = row[1] ? row[1].toString() : "Unknown Coffee";
        coffeeFrequencyMap[coffeeName] = (coffeeFrequencyMap[coffeeName] || 0) + 1;

        var method = row[5] ? row[5].toString() : "Unknown Method";
        methodFrequencyMap[method] = (methodFrequencyMap[method] || 0) + 1;

        // Parse brew time from column Q (index 16) — stored as M:SS string
        var rawDuration = row[16];
        var totalSec = parseBrewTimeToSeconds(rawDuration);
        if (totalSec > 0) {
          totalBrewSecondsSum += totalSec;
          validBrewSecondsCount++;
        }

        // Track unique coffees for the "log existing" dropdown
        if (!allUniqueCoffeesMap[coffeeName]) {
          allUniqueCoffeesMap[coffeeName] = {
            name: row[1] || "",
            producer: row[2] || "",
            processing: row[3] || "",
            roaster: row[4] || "",
            cupping: row[10] || ""
          };
        }

        // Track the most recent brew timestamp per coffee, for the
        // "Recently Brewed Coffees" dashboard list.
        var rowTimestamp = row[0] instanceof Date ? row[0].getTime() : new Date(row[0]).getTime();
        if (!lastBrewedByCoffee[coffeeName] || rowTimestamp > lastBrewedByCoffee[coffeeName]) {
          lastBrewedByCoffee[coffeeName] = rowTimestamp;
        }

        // Track the most recent use of each grinder, so a previously logged
        // grinder can be suggested again instead of retyped.
        var grinderName = row[13] ? row[13].toString().trim() : "";
        if (grinderName) {
          var grinderKey = grinderName.toLowerCase();
          if (!lastUsedByGrinder[grinderKey] || rowTimestamp > lastUsedByGrinder[grinderKey].ts) {
            lastUsedByGrinder[grinderKey] = { ts: rowTimestamp, name: grinderName };
          }
        }
      }
    }

    // Favourite method
    var favMethod = "N/A";
    var maxMethodCount = 0;
    for (var m in methodFrequencyMap) {
      if (methodFrequencyMap[m] > maxMethodCount) {
        maxMethodCount = methodFrequencyMap[m];
        favMethod = m;
      }
    }

    // Dynamic average brew time — averages ALL valid brew times for this user
    var avgBrewTimeStr = "--";
    if (validBrewSecondsCount > 0) {
      var avgSecs = Math.round(totalBrewSecondsSum / validBrewSecondsCount);
      avgBrewTimeStr = formatSecondsToMS(avgSecs);
    }

    // Sort coffees by frequency for the "Most Popular Coffees" chart
    var sortedCoffees = Object.keys(coffeeFrequencyMap).sort(function(a, b) {
      return coffeeFrequencyMap[b] - coffeeFrequencyMap[a];
    });

    // Sort coffees by most recent brew for the "Recently Brewed Coffees" list
    var recentlyBrewedCoffees = Object.keys(lastBrewedByCoffee).sort(function(a, b) {
      return lastBrewedByCoffee[b] - lastBrewedByCoffee[a];
    }).slice(0, 6);

    // Sort grinders by most recent use, so the most recently used one is suggested first
    var knownGrinders = Object.keys(lastUsedByGrinder)
      .sort(function(a, b) { return lastUsedByGrinder[b].ts - lastUsedByGrinder[a].ts; })
      .map(function(k) { return lastUsedByGrinder[k].name; });

    var allUniqueCoffeesArray = Object.values(allUniqueCoffeesMap);

    return {
      totalThisMonth: totalBrews,
      favoriteMethod: favMethod,
      averageBrewTime: avgBrewTimeStr,
      mostRecentCoffeeName: mostRecentCoffeeName,
      recentlyBrewedCoffees: recentlyBrewedCoffees,
      savedRecipes: savedRecipes,
      baseLibrary: baseLibrary,
      allUniqueCoffees: allUniqueCoffeesArray,
      knownGrinders: knownGrinders,
      recentCoffeesChartData: {
        labels: sortedCoffees.slice(0, 3),
        counts: sortedCoffees.slice(0, 3).map(function(c) { return coffeeFrequencyMap[c]; })
      }
    };
  }

  function buildEmptyDashboard() {
    return {
      totalThisMonth: 0,
      favoriteMethod: "N/A",
      averageBrewTime: "--",
      mostRecentCoffeeName: "--",
      recentlyBrewedCoffees: [],
      savedRecipes: getRecipes().map(function(r) { return r.name; }),
      baseLibrary: getBaseLibrary(),
      allUniqueCoffees: [],
      knownGrinders: [],
      recentCoffeesChartData: { labels: [], counts: [] }
    };
  }

  /**
   * Extracts per-coffee brew history for the Coffee Hub detail view.
   * Filtered by userContext (column P).
   */
  function getCoffeeHubData(coffeeName, userContext) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Brews");
    if (!sheet) return { name: coffeeName, producer: "", processing: "", roaster: "", cuppingScore: "--", avUserScore: "--", timesBrewed: 0, timelineLabels: [], timelineSeconds: [], logEntries: [] };

    var data = sheet.getDataRange().getValues();
    var targetUser = userContext ? userContext.trim().toLowerCase() : "jacques";
    var targetCoffee = coffeeName ? coffeeName.trim().toLowerCase() : "";

    var timelineLabels = [];
    var timelineSeconds = [];
    var timelineGrind = [];
    var timelineYield = [];
    var timelineScoreVals = [];
    var timelineWaterTemp = [];
    var logEntries = [];
    var totalScore = 0;
    var countScore = 0;
    var cuppingRef = "--";
    var producerRef = "";
    var processingRef = "";
    var roasterRef = "";

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var rowUser = row[15] ? row[15].toString().trim().toLowerCase() : "";
      var rowCoffee = row[1] ? row[1].toString().trim().toLowerCase() : "";

      if (rowUser === targetUser && (targetCoffee === "" || rowCoffee === targetCoffee)) {
        producerRef = row[2] || producerRef;
        processingRef = row[3] || processingRef;
        roasterRef = row[4] || roasterRef;
        cuppingRef = row[10] || cuppingRef;

        var score = parseFloat(row[9]);
        if (!isNaN(score)) { totalScore += score; countScore++; }

        var rawDuration = row[16];
        var totalSec = parseBrewTimeToSeconds(rawDuration);
        var cleanDurStr = totalSec > 0 ? formatSecondsToMS(totalSec) : "--";

        var formattedDate = row[0] ? Utilities.formatDate(new Date(row[0]), Session.getScriptTimeZone(), "MMM dd") : "Jan 01";

        timelineLabels.push(formattedDate);
        timelineSeconds.push(totalSec);
        timelineGrind.push(extractLeadingNumber_(row[8]));
        timelineYield.push(parseFloat(row[7]) || null);
        timelineScoreVals.push(isNaN(score) ? null : score);
        timelineWaterTemp.push(parseFloat(row[12]) || null);

        logEntries.push({
          date: formattedDate,
          coffee: row[1] || "Unknown",
          method: row[5] || "V60",
          recipe: row[6] || "None",
          yieldAmt: row[7] || "0",
          grind: row[8] || "N/A",
          score: row[9] || "--",
          cupping: row[10] || "N/A",
          waterTemp: row[12] || "",
          grinder: row[13] || "",
          duration: cleanDurStr,
          notes: row[11] || "",
          dose: row[17] || ""
        });
      }
    }

    return {
      name: coffeeName,
      producer: producerRef,
      processing: processingRef,
      roaster: roasterRef,
      cuppingScore: cuppingRef,
      avUserScore: countScore > 0 ? (totalScore / countScore).toFixed(1) : "--",
      timesBrewed: logEntries.length,
      timelineLabels: timelineLabels,
      timelineSeconds: timelineSeconds,
      timelineGrind: timelineGrind,
      timelineYield: timelineYield,
      timelineScore: timelineScoreVals,
      timelineWaterTemp: timelineWaterTemp,
      logEntries: logEntries
    };
  }

  /**
   * Returns every individual brew log row for a user (not grouped by coffee),
   * newest first, for the Brew History screen's filterable list.
   */
  function getBrewHistory(userContext) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Brews");
    if (!sheet) return [];

    var data = sheet.getDataRange().getValues();
    var targetUser = userContext ? userContext.trim().toLowerCase() : "";
    var entries = [];

    for (var i = 1; i < data.length; i++) {
      var row = data[i];
      var rowUser = row[15] ? row[15].toString().trim().toLowerCase() : "";
      if (rowUser !== targetUser) continue;

      var rawDuration = row[16];
      var totalSec = parseBrewTimeToSeconds(rawDuration);
      var timestamp = row[0] instanceof Date ? row[0].getTime() : new Date(row[0]).getTime();
      var formattedDate = row[0] ? Utilities.formatDate(new Date(row[0]), Session.getScriptTimeZone(), "MMM dd, yyyy") : "";

      entries.push({
        timestamp: timestamp,
        date: formattedDate,
        coffee: row[1] || "Unknown",
        producer: row[2] || "",
        processing: row[3] || "",
        roaster: row[4] || "",
        method: row[5] || "",
        recipe: row[6] || "None",
        yieldAmt: row[7] || "0",
        grind: row[8] || "N/A",
        score: parseFloat(row[9]) || 0,
        cupping: row[10] || "",
        notes: row[11] || "",
        waterTemp: row[12] || "",
        grinder: row[13] || "",
        isFavCoffee: !!row[14],
        duration: totalSec > 0 ? formatSecondsToMS(totalSec) : "--",
        dose: row[17] || ""
      });
    }

    entries.sort(function(a, b) { return b.timestamp - a.timestamp; });
    return entries;
  }

  /**
   * Returns recipe details for the recipe card view.
   * Checks both the Recipes sheet and BaseLibrary.
   */
  function getRecipeDetails(recipeName) {
    var recipes = getRecipes();
    for (var i = 0; i < recipes.length; i++) {
      if (recipes[i].name === recipeName) return { name: recipes[i].name, instructions: recipes[i].instructions, overview: recipes[i].overview };
    }
    var base = getBaseLibrary();
    for (var j = 0; j < base.length; j++) {
      if (base[j].name === recipeName) return { name: base[j].name, instructions: base[j].instructions, overview: base[j].overview };
    }
    return { name: recipeName, instructions: "", overview: parseOverviewString("") };
  }

  /**
   * Saves or updates a recipe in the Recipes sheet, including its
   * "Recipe Overview" column (dose/yield/water temp/brew time/ratio,
   * stored as a pipe-delimited "Label: value | Label: value" string).
   */
  function commitRecipeCard(recipeName, instructionsMarkdown, overviewStr) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Recipes");
    if (!sheet) return false;

    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (data[i][0] === recipeName) {
        sheet.getRange(i + 1, 2, 1, 2).setValues([[instructionsMarkdown, overviewStr || ""]]);
        return true;
      }
    }
    // New recipe
    sheet.appendRow([recipeName, instructionsMarkdown, overviewStr || ""]);
    return true;
  }

  // ─── HELPER LIBRARY ──────────────────────────────────────────────────────────

  /**
   * Parses the pipe-delimited "Recipe Overview" cell (e.g. "Dose: 15g | Yield:
   * 250g | Water Temp: 93°C | Brew Time: 3:00 | Ratio: 1:16.7") into a fixed
   * shape. Labels are matched case-insensitively by keyword so the columns can
   * be filled in by hand in any order; any missing ones are left blank.
   */
  function parseOverviewString(raw) {
    var overview = { dose: "", yield: "", waterTemp: "", brewTime: "", ratio: "" };
    if (!raw) return overview;

    raw.toString().split("|").forEach(function(part) {
      var sep = part.indexOf(":");
      if (sep === -1) return;
      var label = part.substring(0, sep).trim().toLowerCase();
      var value = part.substring(sep + 1).trim();
      if (!value) return;

      if (label.indexOf("dose") !== -1) overview.dose = value;
      else if (label.indexOf("yield") !== -1) overview.yield = value;
      else if (label.indexOf("temp") !== -1) overview.waterTemp = value;
      else if (label.indexOf("time") !== -1) overview.brewTime = value;
      else if (label.indexOf("ratio") !== -1) overview.ratio = value;
    });

    return overview;
  }

  function getBaseLibrary() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("BaseLibrary");
    if (!sheet) return [];
    var data = sheet.getDataRange().getValues();
    var list = [];
    for (var i = 1; i < data.length; i++) {
      list.push({ name: data[i][0], icon: data[i][1], instructions: data[i][2], overview: parseOverviewString(data[i][3]) });
    }
    return list;
  }

  function getRecipes() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Recipes");
    if (!sheet) return [];
    var data = sheet.getDataRange().getValues();
    var list = [];
    for (var i = 1; i < data.length; i++) {
      if (data[i][0]) list.push({ name: data[i][0], instructions: data[i][1] || "", overview: parseOverviewString(data[i][2]) });
    }
    return list;
  }

  // ─── BREW LOG ────────────────────────────────────────────────────────────────

  /**
   * Appends a new brew log row to the Brews sheet.
   * Column mapping (1-indexed):
   *  A=Timestamp, B=Coffee/Origin, C=Producer, D=Processing Method,
   *  E=Roaster, F=Brew Method, G=Recipe, H=Total Yield (g), I=Grind Size,
   *  J=My Score, K=Cupping Score, L=Notes, M=Water Temperature,
   *  N=Grinder Model, O=Is Favorite Coffee, P=User Context, Q=Brew time (M:SS string),
   *  R=Dose (g)
   */
  function commitBrewLog(payload) {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Brews");
    if (!sheet) return false;

    sheet.appendRow([
      new Date(),                                    // A - Timestamp
      payload.origin || "",                          // B - Coffee/Origin
      payload.producer || "",                        // C - Producer
      payload.processingMethod || "",                // D - Processing Method
      payload.roaster || "",                         // E - Roaster
      payload.brewMethod || "",                      // F - Brew Method
      payload.recipe || "None",                      // G - Recipe
      parseFloat(payload.totalYield) || 0,           // H - Total Yield (g)
      payload.grindSize || "",                       // I - Grind Size
      parseFloat(payload.myScore) || 0,              // J - My Score
      parseFloat(payload.cuppingScore) || 0,         // K - Cupping Score
      payload.notes || "",                           // L - Notes
      payload.waterTemp || "",                       // M - Water Temperature
      payload.grinder || "",                         // N - Grinder Model
      payload.isFavCoffee ? true : false,            // O - Is Favorite Coffee
      payload.userContext || "Jacques",              // P - User Context
      payload.brewTime || "",                        // Q - Brew time (M:SS string)
      parseFloat(payload.dose) || ""                 // R - Dose (g)
    ]);

    // IMPORTANT: Google Sheets' default "Automatic" number format silently converts a
    // colon string like "3:20" into a time-of-day value (reading it as 3 HOURS : 20
    // MINUTES rather than 3 minutes : 20 seconds), which corrupts the brew time.
    // Force this specific cell to Plain Text and re-write the value so it's stored
    // as a literal string, never a Date/time serial.
    var lastRow = sheet.getLastRow();
    sheet.getRange(lastRow, 17).setNumberFormat('@').setValue(payload.brewTime || "");

    return true;
  }

  /**
   * ONE-TIME MIGRATION — run this manually once from the Apps Script editor
   * (select "fixLegacyBrewTimeFormatting" in the function dropdown and click Run)
   * to repair any existing Brew time values that were corrupted by Sheets'
   * automatic time-conversion.
   *
   * Because Sheets interpreted "M:SS" input as "H:MM" time-of-day, the Date
   * object's hour component actually holds the original MINUTES, and its
   * minute component actually holds the original SECONDS. This function
   * detects any Date-typed cells in column Q, reconstructs the correct
   * M:SS string, and rewrites the column as Plain Text so it can't happen again.
   */
  function fixLegacyBrewTimeFormatting() {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName("Brews");
    if (!sheet) return "No Brews sheet found.";

    var lastRow = sheet.getLastRow();
    if (lastRow < 2) return "No data rows to fix.";

    var range = sheet.getRange(2, 17, lastRow - 1, 1); // Column Q, skip header
    var values = range.getValues();
    var fixedCount = 0;

    for (var i = 0; i < values.length; i++) {
      var val = values[i][0];
      if (val instanceof Date) {
        var correctedMins = val.getHours();
        var correctedSecs = val.getMinutes();
        values[i][0] = correctedMins + ":" + (correctedSecs < 10 ? "0" : "") + correctedSecs;
        fixedCount++;
      }
    }

    range.setNumberFormat('@').setValues(values);
    return "Fixed " + fixedCount + " corrupted brew time value(s). Column Q is now Plain Text.";
  }

  /**
 * Extracts the first number found in a free-text field (e.g. "24 clicks" -> 24,
 * "Fine-Medium" -> null). Used to make text-entered Grind Size plottable on
 * the Coffee Hub comparison chart without forcing users to enter grind as a
 * strict number.
 */
function extractLeadingNumber_(raw) {
  if (!raw) return null;
  var match = raw.toString().match(/[\d.]+/);
  return match ? parseFloat(match[0]) : null;
}

// ─── TIME UTILITIES ──────────────────────────────────────────────────────────

  /**
   * Parses a brew time value into total seconds.
   * Accepts M:SS text (e.g. "3:45", the standard going forward), or legacy
   * Date/time objects that Sheets auto-created from earlier colon-string entries.
   */
  function parseBrewTimeToSeconds(rawDuration) {
    if (!rawDuration) return 0;

    // Legacy Date/time object: Sheets misread "M:SS" as "H:MM" time-of-day, so the
    // hour component is really the minutes originally intended, and the minute
    // component is really the seconds originally intended.
    if (rawDuration instanceof Date) {
      var mins = rawDuration.getHours();
      var secs = rawDuration.getMinutes();
      return (mins * 60) + secs;
    }

    var str = rawDuration.toString().trim();
    if (!str || str === "") return 0;

    if (str.indexOf(":") !== -1) {
      var parts = str.split(":");
      if (parts.length === 2) {
        // M:SS — standard format
        var m = parseInt(parts[0], 10) || 0;
        var s = parseInt(parts[1], 10) || 0;
        return (m * 60) + s;
      } else if (parts.length === 3) {
        // H:MM:SS fallback, in case of very long/legacy entries
        var mins2 = (parseInt(parts[0], 10) * 60) + parseInt(parts[1], 10);
        var secs2 = parseInt(parts[2], 10) || 0;
        return (mins2 * 60) + secs2;
      }
    }

    var plain = parseInt(str, 10);
    return isNaN(plain) ? 0 : plain;
  }

  /**
   * Converts total seconds to M:SS display string.
   */
  function formatSecondsToMS(totalSeconds) {
    var m = Math.floor(totalSeconds / 60);
    var s = totalSeconds % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
