import * as cache from "./cache";
import * as core from "@actions/core";

import { Events, Inputs, State } from "./constants";
import {
    IStateProvider,
    NullStateProvider,
    StateProvider
} from "./stateProvider";
import * as utils from "./utils/actionUtils";

// Catch and log any unhandled exceptions.  These exceptions can leak out of the uploadChunk method in
// @actions/toolkit when a failed upload closes the file descriptor causing any in-process reads to
// throw an uncaught exception.  Instead of failing this action, just warn.
process.on("uncaughtException", e => utils.logWarning(e.message));

export async function saveImpl(
    stateProvider: IStateProvider
): Promise<string | void> {
    let cacheId: string | void = undefined;
    try {
        if (!utils.isCacheFeatureAvailable()) {
            return;
        }

        if (!utils.isValidEvent()) {
            utils.logWarning(
                `Event Validation Error: The event type ${
                    process.env[Events.Key]
                } is not supported because it's not tied to a branch or tag ref.`
            );
            return;
        }

        // If restore has stored a primary key in state, reuse that
        // Else re-evaluate from inputs
        const primaryKey =
            stateProvider.getState(State.CachePrimaryKey) ||
            core.getInput(Inputs.Key);

        if (!primaryKey) {
            utils.logWarning(`Key is not specified.`);
            return;
        }

        // If matched restore key is same as primary key, then do not save cache
        // NO-OP in case of SaveOnly action
        const restoredKey = stateProvider.getCacheState();

        if (utils.isExactKeyMatch(primaryKey, restoredKey)) {
            core.info(
                `Cache hit occurred on the primary key ${primaryKey}, not saving cache.`
            );
            return;
        }

        const cachePaths = utils.getInputAsArray(Inputs.Path, {
            required: true
        });

        const enableCrossOsArchive = utils.getInputAsBool(
            Inputs.EnableCrossOsArchive
        );

        cacheId = await cache.saveCache(
            cachePaths,
            primaryKey,
            { uploadChunkSize: utils.getInputAsInt(Inputs.UploadChunkSize) },
            enableCrossOsArchive
        );

        if (cacheId != undefined) {
            core.info(`Cache saved with key: ${primaryKey}`);
        }
    } catch (error: unknown) {
        utils.logWarning((error as Error).message);
    }
    return cacheId;
}

export async function saveOnlyRun(
    earlyExit?: boolean | undefined
): Promise<void> {
    try {
        const cacheId = await saveImpl(new NullStateProvider());
        if (cacheId === undefined) {
            core.warning(`Cache save failed.`);
        }
    } catch (err) {
        console.error(err);
        if (earlyExit) {
            process.exit(1);
        }
    }

    // node will stay alive if any promises are not resolved,
    // which is a possibility if HTTP requests are dangling
    // due to retries or timeouts. We know that if we got here
    // that all promises that we care about have successfully
    // resolved, so simply exit with success.
    if (earlyExit) {
        process.exit(0);
    }
}

export async function saveRun(earlyExit?: boolean | undefined): Promise<void> {
    try {
        await saveImpl(new StateProvider());
    } catch (err) {
        console.error(err);
        if (earlyExit) {
            process.exit(1);
        }
    }

    // node will stay alive if any promises are not resolved,
    // which is a possibility if HTTP requests are dangling
    // due to retries or timeouts. We know that if we got here
    // that all promises that we care about have successfully
    // resolved, so simply exit with success.
    if (earlyExit) {
        process.exit(0);
    }
}
