/* globals artifacts */
import { BN } from "bn.js";
import chai from "chai";
import bnChai from "bn-chai";

import {
  fundColonyWithTokens,
  setupRatedTask,
  setupFinalizedTask,
  setupColonyNetwork,
  setupMetaColonyWithLockedCLNYToken
} from "../helpers/test-data-generator";

import { INT256_MAX, WAD, MANAGER_PAYOUT, EVALUATOR_PAYOUT, WORKER_PAYOUT } from "../helpers/constants";
import { checkErrorRevert } from "../helpers/test-helper";

const { expect } = chai;
chai.use(bnChai(web3.utils.BN));

const IReputationMiningCycle = artifacts.require("IReputationMiningCycle");

contract("Reputation Updates", accounts => {
  const MANAGER = accounts[0];
  const EVALUATOR = MANAGER;
  const WORKER = accounts[2];
  const OTHER = accounts[3];

  let colonyNetwork;
  let metaColony;
  let clnyToken;
  let inactiveReputationMiningCycle;

  beforeEach(async () => {
    colonyNetwork = await setupColonyNetwork();
    ({ metaColony, clnyToken } = await setupMetaColonyWithLockedCLNYToken(colonyNetwork));

    const amount = WAD.mul(new BN(1000));
    await fundColonyWithTokens(metaColony, clnyToken, amount);

    await colonyNetwork.initialiseReputationMining();
    await colonyNetwork.startNextCycle();
    const inactiveReputationMiningCycleAddress = await colonyNetwork.getReputationMiningCycle(false);
    inactiveReputationMiningCycle = await IReputationMiningCycle.at(inactiveReputationMiningCycleAddress);
  });

  describe("when added", () => {
    it("should be readable", async () => {
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });

      const repLogEntryManager = await inactiveReputationMiningCycle.getReputationUpdateLogEntry(0);
      assert.equal(repLogEntryManager[0], MANAGER);
      expect(repLogEntryManager[1]).to.eq.BN(MANAGER_PAYOUT);
      assert.equal(repLogEntryManager[2].toNumber(), 2);
      assert.equal(repLogEntryManager[3], metaColony.address);
      assert.equal(repLogEntryManager[4].toNumber(), 2);
      assert.equal(repLogEntryManager[5].toNumber(), 0);

      const repLogEntryEvaluator = await inactiveReputationMiningCycle.getReputationUpdateLogEntry(1);
      assert.equal(repLogEntryEvaluator[0], EVALUATOR);
      expect(repLogEntryEvaluator[1]).to.eq.BN(EVALUATOR_PAYOUT);
      assert.equal(repLogEntryEvaluator[2].toNumber(), 2);
      assert.equal(repLogEntryEvaluator[3], metaColony.address);
      assert.equal(repLogEntryEvaluator[4].toNumber(), 2);
      assert.equal(repLogEntryEvaluator[5].toNumber(), 2);

      const repLogEntryWorker = await inactiveReputationMiningCycle.getReputationUpdateLogEntry(2);
      assert.equal(repLogEntryWorker[0], WORKER);
      expect(repLogEntryWorker[1]).to.eq.BN(WORKER_PAYOUT);
      assert.equal(repLogEntryWorker[2].toNumber(), 2);
      assert.equal(repLogEntryWorker[3], metaColony.address);
      assert.equal(repLogEntryWorker[4].toNumber(), 2);
      assert.equal(repLogEntryWorker[5].toNumber(), 4);
    });

    const ratings = [
      {
        manager: 1,
        reputationChangeManager: MANAGER_PAYOUT.neg(),
        worker: 1,
        reputationChangeWorker: WORKER_PAYOUT.neg()
      },
      {
        manager: 2,
        reputationChangeManager: MANAGER_PAYOUT,
        worker: 2,
        reputationChangeWorker: WORKER_PAYOUT
      },
      {
        manager: 3,
        reputationChangeManager: MANAGER_PAYOUT.muln(3).divn(2),
        worker: 3,
        reputationChangeWorker: WORKER_PAYOUT.muln(3).divn(2)
      }
    ];

    ratings.forEach(async rating => {
      it(`should set the correct reputation change amount in log for rating ${rating.worker}`, async () => {
        await setupFinalizedTask({
          colonyNetwork,
          colony: metaColony,
          managerRating: rating.manager,
          workerRating: rating.worker
        });

        const repLogEntryManager = await inactiveReputationMiningCycle.getReputationUpdateLogEntry(0);
        assert.equal(repLogEntryManager[0], MANAGER);
        assert.equal(repLogEntryManager[1].toString(), rating.reputationChangeManager.toString());
        assert.equal(repLogEntryManager[2].toNumber(), 2);
        assert.equal(repLogEntryManager[3], metaColony.address);
        // If the rating is less than 2, then we also subtract reputation from all child skills. In the case
        // of the metaColony here, the task was created in the root domain of the metaColony, and a child of the
        // root skill is the mining skill. So the number we expect here differs depending on whether it's a reputation
        // gain or loss that we're logging.
        if (rating.manager >= 2) {
          assert.equal(repLogEntryManager[4].toNumber(), 2);
        } else {
          assert.equal(repLogEntryManager[4].toNumber(), 4);
        }
        assert.equal(repLogEntryManager[5].toNumber(), 0);

        const repLogEntryWorker = await inactiveReputationMiningCycle.getReputationUpdateLogEntry(2);
        assert.equal(repLogEntryWorker[0], WORKER);
        assert.equal(repLogEntryWorker[1].toString(), rating.reputationChangeWorker.toString());
        assert.equal(repLogEntryWorker[2].toNumber(), 2);
        assert.equal(repLogEntryWorker[3], metaColony.address);
        if (rating.worker >= 2) {
          assert.equal(repLogEntryWorker[4].toNumber(), 2);
        } else {
          assert.equal(repLogEntryWorker[4].toNumber(), 4);
        }
        // This last entry in the log entry is nPreviousUpdates, which depends on whether the manager was given a reputation
        // gain or loss.
        if (rating.manager >= 2) {
          assert.equal(repLogEntryWorker[5].toNumber(), 4);
        } else {
          assert.equal(repLogEntryWorker[5].toNumber(), 6);
        }
      });
    });

    it("should not be able to be appended by an account that is not a colony", async () => {
      const lengthBefore = await inactiveReputationMiningCycle.getReputationUpdateLogLength();
      await checkErrorRevert(colonyNetwork.appendReputationUpdateLog(OTHER, 1, 2), "colony-caller-must-be-colony");
      const lengthAfter = await inactiveReputationMiningCycle.getReputationUpdateLogLength();
      assert.equal(lengthBefore.toNumber(), lengthAfter.toNumber());
    });

    it("should populate nPreviousUpdates correctly", async () => {
      const initialRepLogLength = await inactiveReputationMiningCycle.getReputationUpdateLogLength();
      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      let repLogEntry = await inactiveReputationMiningCycle.getReputationUpdateLogEntry(initialRepLogLength);
      const nPrevious = repLogEntry[5];
      repLogEntry = await inactiveReputationMiningCycle.getReputationUpdateLogEntry(initialRepLogLength + 1);
      assert.equal(repLogEntry[5].toNumber(), nPrevious.addn(2).toNumber());

      await setupFinalizedTask({ colonyNetwork, colony: metaColony });
      repLogEntry = await inactiveReputationMiningCycle.getReputationUpdateLogEntry(initialRepLogLength + 2);
      assert.equal(repLogEntry[5].toNumber(), nPrevious.addn(4).toNumber());
    });

    it("should calculate nUpdates correctly when making a log", async () => {
      await metaColony.addGlobalSkill(1);
      await metaColony.addGlobalSkill(4);
      await metaColony.addGlobalSkill(5);
      await metaColony.addGlobalSkill(6);

      await setupFinalizedTask({ colonyNetwork, colony: metaColony, skillId: 5 });
      let repLogEntryWorker = await inactiveReputationMiningCycle.getReputationUpdateLogEntry(3);
      assert.equal(repLogEntryWorker[1].toString(), WORKER_PAYOUT.toString());
      assert.equal(repLogEntryWorker[4].toNumber(), 6);

      await setupFinalizedTask({ colonyNetwork, colony: metaColony, skillId: 6 });
      repLogEntryWorker = await inactiveReputationMiningCycle.getReputationUpdateLogEntry(7);
      assert.equal(repLogEntryWorker[1].toString(), WORKER_PAYOUT.toString());
      assert.equal(repLogEntryWorker[4].toNumber(), 8); // Negative reputation change means children change as well.
    });

    it("should revert on reputation amount overflow", async () => {
      // Fund colony with maximum possible int number of tokens
      await fundColonyWithTokens(metaColony, clnyToken, INT256_MAX);
      // Split the tokens as payouts between the manager, evaluator, and worker
      const managerPayout = new BN("2");
      const evaluatorPayout = new BN("1");
      const workerPayout = INT256_MAX.sub(managerPayout).sub(evaluatorPayout);

      const taskId = await setupRatedTask({
        colonyNetwork,
        colony: metaColony,
        token: clnyToken,
        managerPayout,
        evaluatorPayout,
        workerPayout
      });

      // Check the task pot is correctly funded with the max amount
      const taskPotBalance = await metaColony.getPotBalance(2, clnyToken.address);
      expect(taskPotBalance).to.eq.BN(INT256_MAX);
      await checkErrorRevert(metaColony.finalizeTask(taskId), "colony-math-unsafe-int-mul");
    });
  });
});
