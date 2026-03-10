import "dotenv/config";
import express from "express";
import cors from "cors";
import OpenAI from "openai";

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

const client = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use(cors({ origin: allowedOrigin === "*" ? true : allowedOrigin }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "jouetmalins-openai-backend" });
});

function cleanStore(store) {
  return {
    brand: String(store.brand || "Magasin"),
    best_price: Number(store.best_price),
    nearest_distance_km:
      store.nearest_distance_km === null || store.nearest_distance_km === undefined
        ? null
        : Number(store.nearest_distance_km),
  };
}

function fallbackSummary(payload) {
  const modeLabel =
    payload.mode === "economy"
      ? "économie"
      : payload.mode === "proximity"
      ? "proximité"
      : "équilibré";

  const locals = (payload.local_stores || [])
    .map(cleanStore)
    .filter((x) => Number.isFinite(x.best_price));

  const allStores = (payload.all_stores || [])
    .map(cleanStore)
    .filter((x) => Number.isFinite(x.best_price));

  const pool = locals.length ? locals : allStores;
  if (!pool.length) {
    return "Aucun prix exploitable n’a été trouvé pour ce produit.";
  }

  let chosen = pool[0];

  if (payload.mode === "economy") {
    chosen = [...pool].sort((a, b) => a.best_price - b.best_price)[0];
  } else if (payload.mode === "proximity") {
    chosen = [...pool].sort((a, b) => {
      const da = a.nearest_distance_km ?? 9999;
      const db = b.nearest_distance_km ?? 9999;
      return da - db || a.best_price - b.best_price;
    })[0];
  } else {
    chosen = [...pool].sort((a, b) => {
      const sa = a.best_price + ((a.nearest_distance_km ?? 50) * 0.03);
      const sb = b.best_price + ((b.nearest_distance_km ?? 50) * 0.03);
      return sa - sb || a.best_price - b.best_price;
    })[0];
  }

  const distance =
    chosen.nearest_distance_km === null || chosen.nearest_distance_km === undefined
      ? "distance inconnue"
      : `${chosen.nearest_distance_km.toFixed(1).replace(".", ",")} km`;

  return `En mode ${modeLabel}, l’option recommandée est ${chosen.brand} à ${chosen.best_price
    .toFixed(2)
    .replace(".", ",")} € (${distance}).`;
}

app.post("/ai-summary", async (req, res) => {
  try {
    const payload = req.body || {};
    const product = payload.product || {};
    const mode = String(payload.mode || "balanced");
    const radiusKm = Number(payload.radius_km || 20);

    const localStores = Array.isArray(payload.local_stores)
      ? payload.local_stores.map(cleanStore).filter((x) => Number.isFinite(x.best_price))
      : [];

    const allStores = Array.isArray(payload.all_stores)
      ? payload.all_stores.map(cleanStore).filter((x) => Number.isFinite(x.best_price))
      : [];

    if (!product.name || !allStores.length) {
      return res.status(400).json({
        error: "Payload invalide. Il faut au minimum product.name et all_stores."
      });
    }

    const fallback = fallbackSummary({
      product,
      mode,
      radius_km: radiusKm,
      local_stores: localStores,
      all_stores: allStores
    });

    if (!client) {
      return res.json({
        summary: fallback,
        fallback,
        model,
        source: "fallback_local"
      });
    }

    const instructions = `
Tu aides un comparateur de prix alimentaire français.
Ta mission: recommander UN magasin proche de l'utilisateur à partir des données fournies.
Tu ne dois jamais inventer de prix, de magasins, de distances, ni de disponibilité.
Tu dois répondre en français, en 2 ou 3 phrases maximum.
Priorités selon le mode:
- economy: privilégie le prix le plus bas
- proximity: privilégie la distance la plus faible
- balanced: fais un compromis raisonnable entre prix et distance
Si aucun magasin local n'est disponible, dis-le clairement puis cite le meilleur prix global.
Reste concret, utile, et facile à comprendre.
    `.trim();

    const inputPayload = {
      product,
      mode,
      radius_km: radiusKm,
      local_stores: localStores,
      all_stores: allStores
    };

    const response = await client.responses.create({
      model,
      instructions,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(inputPayload, null, 2)
            }
          ]
        }
      ],
      max_output_tokens: 180
    });

    const summary = response.output_text?.trim() || fallback;

    res.json({
      summary,
      fallback,
      model,
      source: "openai"
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: "Impossible de générer le résumé IA.",
      details: error?.message || "unknown_error"
    });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`JouetMalins OpenAI backend sur http://0.0.0.0:${port}`);
});
