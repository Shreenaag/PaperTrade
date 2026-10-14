import { createDb } from "../src/infra/db.js";

try { process.loadEnvFile("../.env"); } catch {}

// Tradable universe for the simulator. Prices are rough starting points, not live data.
const instruments = [
  { symbol: "RELIANCE", name: "Reliance Industries", initialPrice: "2900.00", volatility: 0.22 },
  { symbol: "TCS", name: "Tata Consultancy Services", initialPrice: "3800.00", volatility: 0.2 },
  { symbol: "INFY", name: "Infosys", initialPrice: "1500.00", volatility: 0.24 },
  { symbol: "HDFCBANK", name: "HDFC Bank", initialPrice: "1650.00", volatility: 0.2 },
  { symbol: "ICICIBANK", name: "ICICI Bank", initialPrice: "1200.00", volatility: 0.22 },
  { symbol: "SBIN", name: "State Bank of India", initialPrice: "800.00", volatility: 0.28 },
  { symbol: "ITC", name: "ITC", initialPrice: "450.00", volatility: 0.18 },
  { symbol: "LT", name: "Larsen & Toubro", initialPrice: "3500.00", volatility: 0.24 },
  { symbol: "BHARTIARTL", name: "Bharti Airtel", initialPrice: "1550.00", volatility: 0.23 },
  { symbol: "WIPRO", name: "Wipro", initialPrice: "500.00", volatility: 0.26 },
];

const db = createDb(process.env["DATABASE_URL"]!);
try {
  for (const i of instruments) {
    await db.instrument.upsert({ where: { symbol: i.symbol }, create: i, update: {} }); // re-runnable
  }
  console.log(`seeded ${instruments.length} instruments`);
} finally {
  await db.$disconnect();
}
