// https://github.com/actions/toolkit/blob/main/packages/cache/src/cache.ts
// 6c4e082c181a51609197e536ef5255a0c9baeef7

import * as core from "@actions/core";
import { TosClient, TosClientError, TosServerError } from "@volcengine/tos-sdk";
import * as crypto from "crypto";

import { DownloadOptions, UploadOptions } from "../options";
import * as utils from "./cacheUtils";
import { CompressionMethod } from "./constants";
import { ArtifactCacheEntry, InternalCacheOptions } from "./contracts.d";

const versionSalt = "1.0";

const bucket = process.env["BUCKET_NAME"];
const repo = process.env["GITHUB_REPOSITORY"];
const workflowHash = process.env["GITHUB_WORKFLOW_SHA"];
const ref = process.env["GITHUB_REF"];

function createObjectStorageClient(): TosClient {
    return new TosClient({
        accessKeyId: process.env["ACCESS_KEY"] as string,
        accessKeySecret: process.env["SECRET_KEY"] as string,
        region: process.env["REGION"] as string
    });
}

export function getCacheVersion(
    paths: string[],
    compressionMethod?: CompressionMethod,
    enableCrossOsArchive = false
): string {
    // don't pass changes upstream
    const components = paths.slice();

    // Add compression method to cache version to restore
    // compressed cache as per compression method
    if (compressionMethod) {
        components.push(compressionMethod);
    }

    // Only check for windows platforms if enableCrossOsArchive is false
    if (process.platform === "win32" && !enableCrossOsArchive) {
        components.push("windows-only");
    }

    // Add salt to cache version to support breaking changes in cache entry
    components.push(versionSalt);

    return crypto
        .createHash("sha256")
        .update(components.join("|"))
        .digest("hex");
}

export async function getCacheEntry(
    keys: string[],
    paths: string[],
    options?: InternalCacheOptions
): Promise<ArtifactCacheEntry | null> {
    const client = createObjectStorageClient();
    const version = getCacheVersion(
        paths,
        options?.compressionMethod,
        options?.enableCrossOsArchive
    );

    for (const key of keys) {
        const objectKey = `caches/${repo}/${ref}/${workflowHash}/${key}`;
        try {
            await client.headObject({
                bucket: bucket,
                key: objectKey
            });
            const entry: ArtifactCacheEntry = {
                cacheKey: key,
                cacheVersion: version,
                objectKey: objectKey
            };
            return entry;
        } catch (error) {
            if (error instanceof TosServerError && error.statusCode === 404) {
                console.warn(`Unable to find cache with key ${objectKey}.`);
            }
        }
    }
    const entry: ArtifactCacheEntry = {
        cacheVersion: version
    };
    console.warn(`Failed to find cache that matches keys: ${keys}`);
    return entry;
}

export async function downloadCache(
    objectKey: string,
    archivePath: string,
    options?: DownloadOptions
): Promise<void> {
    const client = createObjectStorageClient();
    await client.getObjectToFile({
        bucket: bucket,
        key: objectKey,
        filePath: archivePath
    });
}

function handleError(error) {
    if (error instanceof TosClientError) {
        console.log("Client Err Msg:", error.message);
        console.log("Client Err Stack:", error.stack);
    } else if (error instanceof TosServerError) {
        console.log("Request ID:", error.requestId);
        console.log("Response Status Code:", error.statusCode);
        console.log("Response Header:", error.headers);
        console.log("Response Err Code:", error.code);
        console.log("Response Err Msg:", error.message);
    } else {
        console.log("unexpected exception, message: ", error);
    }
}

async function uploadFile(
    client: TosClient,
    cacheId: string,
    archivePath: string,
    options?: UploadOptions
): Promise<void> {
    try {
        const objectName = `caches/${repo}/${ref}/${workflowHash}/${cacheId}`;
        await client.putObjectFromFile({
            bucket: bucket,
            key: objectName,
            filePath: archivePath
        });
    } catch (error) {
        handleError(error);
    }
}

export async function saveCache(
    cacheId: string,
    archivePath: string,
    options?: UploadOptions
): Promise<void> {
    const client = createObjectStorageClient();

    core.debug("Upload cache");
    await uploadFile(client, cacheId, archivePath, options);

    // Commit Cache
    core.debug("Commiting cache");
    const cacheSize = utils.getArchiveFileSizeInBytes(archivePath);
    core.info(
        `Cache Size: ~${Math.round(
            cacheSize / (1024 * 1024)
        )} MB (${cacheSize} B)`
    );

    core.info("Cache saved successfully");
}