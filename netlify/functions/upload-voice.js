// netlify/functions/upload-voice.js
// Deploy this on Netlify. Roblox calls this endpoint (allowed, since it's
// NOT a roblox.com domain) with the generated MP3 audio; this function then
// calls Roblox's Open Cloud Assets API itself (allowed, since this code
// runs on Netlify's servers, not inside Roblox's HttpService) and returns
// the resulting asset ID back to Roblox.
//
// Note: Netlify's synchronous function timeout defaults to 10 seconds
// (vs. much longer on Vercel), so the polling budget below is kept short
// to stay safely inside that limit.

exports.handler = async function (event) {
  const json = (statusCode, obj) => ({
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(obj),
  });

  if (event.httpMethod !== "POST") {
    return json(405, { error: "Use POST" });
  }

  // Simple shared-secret check so random people can't hit your endpoint
  // and burn your Open Cloud quota. Set RELAY_SHARED_SECRET in Netlify's
  // environment variables, and send the same value from Roblox.
  const headers = event.headers || {};
  const providedSecret = headers["x-relay-secret"] || headers["X-Relay-Secret"];
  if (!process.env.RELAY_SHARED_SECRET || providedSecret !== process.env.RELAY_SHARED_SECRET) {
    return json(401, { error: "Unauthorized" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch (err) {
    return json(400, { error: "Invalid JSON body" });
  }

  const { audioBase64, displayName, creatorUserId } = payload;
  if (!audioBase64 || !creatorUserId) {
    return json(400, { error: "Missing audioBase64 or creatorUserId" });
  }

  console.log("OPEN_CLOUD_KEY exists:", !!process.env.OPEN_CLOUD_KEY);
  console.log(
    "OPEN_CLOUD_KEY prefix:",
    process.env.OPEN_CLOUD_KEY
      ? process.env.OPEN_CLOUD_KEY.slice(0, 6)
      : "MISSING"
  );
  if (!process.env.OPEN_CLOUD_KEY) {
    return json(500, { error: "Server misconfigured: OPEN_CLOUD_KEY not set" });
  }

  const gameId = process.env.UNIVERISE_ID;

  try {
    const audioBuffer = Buffer.from(audioBase64, "base64");

    const requestJson = JSON.stringify({
      assetType: "Audio",
      displayName: displayName || `Verity line ${Date.now()}`,
      description: "Verity voice line",
      creationContext: {
        creator: { userId: String(creatorUserId) },
      },
    });

    const form = new FormData();
    form.append("request", requestJson);
    form.append("fileContent", new Blob([audioBuffer], { type: "audio/mpeg" }), "verity.mp3");

    const uploadRes = await fetch("https://apis.roblox.com/assets/v1/assets", {
      method: "POST",
      headers: { "x-api-key": process.env.OPEN_CLOUD_KEY },
      body: form,
    });

    const uploadText = await uploadRes.text();
    if (!uploadRes.ok) {
      return json(502, { error: "Open Cloud upload failed", detail: uploadText });
    }

    const uploadJson = JSON.parse(uploadText);

    // If already done, return immediately
    if (uploadJson.done && uploadJson.response && uploadJson.response.assetId) {
      return json(200, { assetId: String(uploadJson.response.assetId) });
    }

    const operationPath = uploadJson.path;
    if (!operationPath) {
      return json(502, { error: "Unexpected Open Cloud response", detail: uploadText });
    }

    // Short polling budget to stay safely inside Netlify's 10s default timeout.
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800));

      const pollRes = await fetch(`https://apis.roblox.com/assets/v1/${operationPath}`, {
        headers: { "x-api-key": process.env.OPEN_CLOUD_KEY },
      });
      const pollJson = await pollRes.json();

      if (pollJson.done) {
        if (pollJson.response && pollJson.response.assetId) {
          return json(200, { assetId: String(pollJson.response.assetId) });
        }
        return json(502, { error: "Operation finished but no assetId", detail: JSON.stringify(pollJson) });
      }
    }

    return json(504, { error: "Timed out waiting for asset processing" });
  } catch (err) {
    return json(500, { error: "Unexpected error", detail: String(err) });
  }
};
