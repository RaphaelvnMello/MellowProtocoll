import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {},
    // Rede de teste Polygon Amoy (scripts/cicloAmoy.ts). Só é usada com --network amoy;
    // sem as variáveis de ambiente, a configuração fica vazia e não afeta os testes locais.
    amoy: {
      url: process.env.AMOY_RPC_URL ?? "",
      chainId: 80002,
      accounts: [process.env.AMOY_PK_CONTRATANTE, process.env.AMOY_PK_PRESTADOR, process.env.AMOY_PK_ARBITRO].filter(
        (k): k is string => typeof k === "string" && k.length > 0
      ),
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS !== undefined ? process.env.REPORT_GAS !== "false" : true,
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    token: "MATIC",
    L1: "polygon",
    outputFile: process.env.CI ? "gas-report.txt" : undefined,
    noColors: process.env.CI ? true : false,
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
  },
};

export default config;
