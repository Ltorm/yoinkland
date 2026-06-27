// Sponsor links shown in the nav bar "Sponsors" dropdown. `name` is the label
// (no .com / .vercel.app, no hyphens); `url` is the full external link.
export interface Sponsor {
  name: string;
  url: string;
}

export const SPONSORS: Sponsor[] = [
  { name: "CrossCoastGaming", url: "https://CrossCoastGaming.com" },
  { name: "TradeandTell", url: "https://TradeandTell.com" },
  { name: "DeepValueFlow", url: "https://DeepValueFlow.com" },
  { name: "CheapJapanHomes", url: "https://CheapJapanHomes.com" },
  { name: "BKKBNB", url: "https://BKKBNB.com" },
  { name: "BryanCurran", url: "https://BryanCurran.com" },
  { name: "mergersignal", url: "https://merger-signal.vercel.app/" },
  {
    name: "arcraidersgoopcom",
    url: "https://arc-raiders-goop-com.vercel.app/",
  },
];
