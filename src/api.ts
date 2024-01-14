import { JacobianPoint, fromHex, toHex } from "chia-bls";
import {
  CoinSpend,
  SpendBundle,
  formatHex,
  sanitizeHex,
  toCoinId,
} from "chia-rpc";
import { CoinSelection, puzzles } from "chia-wallet-lib";
import { Program } from "clvm-lib";
import {
  getWallet,
  getNode,
  loadPuzzle,
  calculateFee,
  getGenesisChallenge,
} from "./utils";
import { constants } from "./constants";
import { Options } from "./utils";
import { ConditionCodes } from "chia-condition-codes";

const mirrorPuzzle = loadPuzzle("p2_parent");

// curry in morpher = 1
const curriedMirrorPuzzle = mirrorPuzzle.curry([Program.fromInt(1)]);
const launcherId = Program.fromHex(
  "d4afd611d20e85edfed3904f20d2ecffd7109e59ac3681936edce4cc7847da8f"
);

export const createCsamCoin = async (
  storeIds: Program[],
  amount: number = constants.defaultCoinAmountInMojo,
  options?: Options
) => {
  const node = await getNode(options);
  const wallet = await getWallet(node);

  await wallet.sync();

  const hint = Program.fromBigInt(launcherId.toBigInt() + 2n)
    .toHex()
    .padStart(64, "0")
    .slice(0, 64);

  let fee = options?.feeOverride;
  if (!fee) {
    fee = await calculateFee();
  }

  const coinRecords = wallet.selectCoinRecords(
    amount + fee,
    CoinSelection.Smallest
  );

  if (!coinRecords.length) throw new Error("Insufficient balance");

  const totalValue = coinRecords.reduce((acc, coinRecord) => {
    return acc + coinRecord.coin.amount;
  }, 0);

  const changeAmount = totalValue - fee - amount;

  const coinSpends = coinRecords.map((coinRecord, index) => {
    const spentPuzzle = wallet.puzzleCache.find(
      (puzzle) => puzzle.hashHex() === sanitizeHex(coinRecord.coin.puzzle_hash)
    )!;

    let solution = [] as Program[];

    if (index === 0) {
      solution.push(
        Program.fromSource(
          `(${
            ConditionCodes.CREATE_COIN
          } 0x${curriedMirrorPuzzle.hashHex()} ${amount} (0x${hint} ${storeIds.join(
            " "
          )}))`
        )
      );

      // Send the change to the same address
      solution.push(
        Program.fromSource(
          `(${ConditionCodes.CREATE_COIN} ${formatHex(
            coinRecord.coin.puzzle_hash
          )} ${changeAmount})`
        )
      );
    }

    const coinSpend: CoinSpend = {
      coin: coinRecord.coin,
      puzzle_reveal: spentPuzzle.serializeHex(),
      solution: spentPuzzle.getSolution(solution).serializeHex(),
    };

    return coinSpend;
  });

  const spendBundle: SpendBundle = {
    coin_spends: coinSpends,
    aggregated_signature: JacobianPoint.infinityG2().toHex(),
  };

  const aggSigMeExtraData = fromHex(getGenesisChallenge());

  wallet.signSpend(spendBundle, aggSigMeExtraData);

  console.log(await node.pushTx(spendBundle));
};

export const deleteCsamCoin = async (coinId: string, options?: Options) => {
  const node = await getNode(options);
  const wallet = await getWallet(node);

  await wallet.sync();

  const coinRecordResponse = await node.getCoinRecordByName(coinId);

  if (!coinRecordResponse.success) {
    throw new Error("Failed to get coin record");
  }

  const puzzleSolution = await node.getPuzzleAndSolution(
    coinRecordResponse.coin_record.coin.parent_coin_info,
    coinRecordResponse.coin_record.confirmed_block_index
  );

  if (!puzzleSolution.success) {
    throw new Error("Failed to get puzzle and solution");
  }

  const revealProgram = Program.deserializeHex(
    sanitizeHex(puzzleSolution.coin_solution.puzzle_reveal)
  );

  const delegatedPuzzle = puzzles.payToConditions.run(
    Program.fromList([Program.nil])
  ).value;

  const standardTransactionInnerSolution = Program.fromList([
    Program.nil,
    delegatedPuzzle,
    Program.nil,
  ]);

  let fee = options?.feeOverride;
  if (!fee) {
    fee = await calculateFee();
  }

  const coinRecords = wallet.selectCoinRecords(1 + fee, CoinSelection.Smallest);

  if (!coinRecords.length) throw new Error("Insufficient balance");

  const totalValue = coinRecords.reduce((acc, coinRecord) => {
    return acc + coinRecord.coin.amount;
  }, 0);

  const changeAmount = totalValue - fee;

  const coinSpends = coinRecords.map((coinRecord, index) => {
    const spentPuzzle = wallet.puzzleCache.find(
      (puzzle) => puzzle.hashHex() === sanitizeHex(coinRecord.coin.puzzle_hash)
    )!;

    let solution = [] as Program[];

    if (index === 0) {
      // Send the change to the same address
      solution.push(
        Program.fromSource(
          `(${ConditionCodes.CREATE_COIN} ${formatHex(
            coinRecord.coin.puzzle_hash
          )} ${changeAmount})`
        )
      );
    }

    const coinSpend: CoinSpend = {
      coin: coinRecord.coin,
      puzzle_reveal: spentPuzzle.serializeHex(),
      solution: spentPuzzle.getSolution(solution).serializeHex(),
    };

    return coinSpend;
  });

  const deleteCoinSpend: CoinSpend = {
    coin: coinRecordResponse.coin_record.coin,
    puzzle_reveal: curriedMirrorPuzzle.serializeHex(),
    solution: Program.fromSource(
      `(${puzzleSolution.coin_solution.coin.parent_coin_info} ${revealProgram} ${puzzleSolution.coin_solution.coin.amount} ${standardTransactionInnerSolution})`
    ).serializeHex(),
  };

  coinSpends.push(deleteCoinSpend);

  const spendBundle: SpendBundle = {
    coin_spends: coinSpends,
    aggregated_signature: JacobianPoint.infinityG2().toHex(),
  };

  const aggSigMeExtraData = fromHex(getGenesisChallenge());

  wallet.signSpend(spendBundle, aggSigMeExtraData);

  console.log(await node.pushTx(spendBundle));
};

export const getCsamCoinsByLauncherId = async (
  options?: Options
) => {
  const node = await getNode(options);
  const wallet = await getWallet(node);

  await wallet.sync();

  // Hint is launcherId + 2 to distinguish from Mirror Coin and Server Coin
  const hint = Program.fromBigInt(launcherId.toBigInt() + 2n)
    .toHex()
    .padStart(64, "0")
    .slice(0, 64);

  const response = await node.getCoinRecordsByHint(hint);

  if (!response.success) {
    throw new Error("Failed to get coin records");
  }

  const servers = [] as object[];

  for (const coinRecord of response.coin_records) {
    const puzzleSolution = await node.getPuzzleAndSolution(
      coinRecord.coin.parent_coin_info,
      coinRecord.confirmed_block_index
    );

    if (!puzzleSolution.success) {
      throw new Error("Failed to get puzzle and solution");
    }

    const revealProgram = Program.deserializeHex(
      sanitizeHex(puzzleSolution.coin_solution.puzzle_reveal)
    );
    const solutionProgram = Program.deserializeHex(
      sanitizeHex(puzzleSolution.coin_solution.solution)
    );

    const conditions = revealProgram.run(solutionProgram).value;

    const createCoinConditions = conditions.toList().filter((condition) => {
      if (
        condition.toList().length === 4 &&
        condition.rest.first.equals(
          Program.fromHex(sanitizeHex(curriedMirrorPuzzle.hashHex()))
        )
      ) {
        return condition.first.toInt() === 51;
      }
      return false;
    });

    const storeIdsString = createCoinConditions.map((condition) => {
      return condition.rest.rest.rest.first.rest;
    });

    const urls = storeIdsString[0].toList().map((storeId) => storeId.toText());

    const ourPuzzle = wallet.puzzleCache.find((puzzle) =>
      puzzle.equals(revealProgram)
    );

    servers.push({
      amount: coinRecord.coin.amount,
      coin_id: sanitizeHex(formatHex(toHex(toCoinId(coinRecord.coin)))),
      launcher_id: sanitizeHex(formatHex(launcherId.toHex())),
      ours: ourPuzzle !== undefined,
      urls,
    });
  }

  console.log(JSON.stringify({ servers }, null, 2));
  return { servers };
};
