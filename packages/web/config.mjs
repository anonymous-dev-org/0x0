const stage = process.env.SST_STAGE || "dev"

export default {
  url: stage === "production" ? "https://zeroxzero.ai" : `https://${stage}.zeroxzero.ai`,
  console: stage === "production" ? "https://zeroxzero.ai/auth" : `https://${stage}.zeroxzero.ai/auth`,
  email: "contact@anoma.ly",
  socialCard: "https://social-cards.sst.dev",
  github: "https://github.com/anomalyco/zeroxzero",
  discord: "https://zeroxzero.ai/discord",
  headerLinks: [
    { name: "Home", url: "/" },
    { name: "Docs", url: "/docs/" },
  ],
}
