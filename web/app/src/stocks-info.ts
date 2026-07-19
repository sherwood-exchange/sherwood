// Curated descriptions for the tokenized stocks on Sherwood. DexScreener / GeckoTerminal carry no
// description for these (they track real-world equities), so the token page falls back to this map
// to give users real context. Blurbs are concise and factual; `sector` powers a small tag.
export interface StockInfo { name: string; sector: string; blurb: string; }

export const STOCK_INFO: Record<string, StockInfo> = {
  AAPL: { name: "Apple Inc.", sector: "Technology", blurb: "Designs the iPhone, Mac, iPad and Apple Watch, plus a fast-growing services business (App Store, iCloud, Apple Pay). One of the world's most valuable companies." },
  TSLA: { name: "Tesla, Inc.", sector: "Automotive", blurb: "Electric-vehicle maker and clean-energy company — cars, batteries, solar and autonomous-driving software led by Elon Musk." },
  NVDA: { name: "NVIDIA Corp.", sector: "Semiconductors", blurb: "The dominant maker of GPUs and AI accelerators powering data-center training, gaming and accelerated computing." },
  AMD: { name: "Advanced Micro Devices", sector: "Semiconductors", blurb: "Designs CPUs (Ryzen, EPYC) and GPUs, competing with Intel and NVIDIA across PCs, servers and AI." },
  SPCX: { name: "SpaceX", sector: "Aerospace", blurb: "Private space-launch company behind Falcon rockets, Dragon spacecraft and the Starlink satellite-internet network. Pre-IPO — tokenized exposure only." },
  GOOGL: { name: "Alphabet Inc. (Class A)", sector: "Technology", blurb: "Parent of Google — search, advertising, YouTube, Android and Google Cloud, plus AI research at DeepMind." },
  AMZN: { name: "Amazon.com, Inc.", sector: "Consumer / Cloud", blurb: "The largest e-commerce marketplace and, via AWS, the leading cloud-infrastructure provider." },
  APLD: { name: "Applied Digital", sector: "Data Centers", blurb: "Builds and operates data-center infrastructure for high-performance and AI compute workloads." },
  COIN: { name: "Coinbase Global", sector: "Crypto / Finance", blurb: "The largest US-listed crypto exchange, offering trading, custody, staking and stablecoin infrastructure." },
  CRCL: { name: "Circle Internet Group", sector: "Crypto / Finance", blurb: "Issuer of USDC, one of the largest regulated dollar stablecoins, and payments infrastructure for on-chain money." },
  CRWV: { name: "CoreWeave", sector: "Cloud Computing", blurb: "A specialized GPU cloud provider renting NVIDIA compute at scale for AI training and inference." },
  F: { name: "Ford Motor Company", sector: "Automotive", blurb: "Legacy US automaker producing trucks, SUVs and the F-Series, now investing heavily in electric vehicles." },
  GME: { name: "GameStop Corp.", sector: "Retail", blurb: "Video-game and collectibles retailer, famous as the original 2021 meme-stock short squeeze." },
  INTC: { name: "Intel Corp.", sector: "Semiconductors", blurb: "Integrated chipmaker producing CPUs and building out a foundry business to manufacture chips for others." },
  MU: { name: "Micron Technology", sector: "Semiconductors", blurb: "A leading maker of DRAM and NAND memory and storage, critical to PCs, phones, servers and AI." },
  NU: { name: "Nu Holdings (Nubank)", sector: "Finance", blurb: "Latin America's largest digital bank, serving tens of millions across Brazil, Mexico and Colombia." },
  ORCL: { name: "Oracle Corp.", sector: "Technology", blurb: "Enterprise software giant known for databases and, increasingly, Oracle Cloud Infrastructure for AI." },
  PLTR: { name: "Palantir Technologies", sector: "Software", blurb: "Builds data-analytics and AI platforms (Gotham, Foundry, AIP) for governments and large enterprises." },
  QQQ: { name: "Invesco QQQ Trust", sector: "ETF", blurb: "An ETF tracking the Nasdaq-100 — the 100 largest non-financial companies on the Nasdaq, tech-heavy." },
  RKLB: { name: "Rocket Lab", sector: "Aerospace", blurb: "Small-satellite launch provider (Electron rocket) and space-systems manufacturer, developing the larger Neutron." },
  SLV: { name: "iShares Silver Trust", sector: "Commodity ETF", blurb: "An ETF that holds physical silver, giving price exposure to the metal without holding bullion directly." },
  SNDK: { name: "SanDisk Corp.", sector: "Storage", blurb: "Flash-memory and SSD maker (spun out of Western Digital), supplying consumer and enterprise storage." },
  SPY: { name: "SPDR S&P 500 ETF", sector: "ETF", blurb: "The original and most-traded ETF, tracking the S&P 500 index of large US companies." },
};
