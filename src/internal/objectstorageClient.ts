// https://github.com/actions/toolkit/blob/main/packages/cache/src/cache.ts
// 6c4e082c181a51609197e536ef5255a0c9baeef7

import * as core from '@actions/core'
import {HttpClient} from '@actions/http-client'
import {BearerCredentialHandler} from '@actions/http-client/lib/auth'
import {
  RequestOptions,
  TypedResponse
} from '@actions/http-client/lib/interfaces'
import * as crypto from 'crypto'
import * as fs from 'fs'
import {URL} from 'url'

import * as utils from './cacheUtils'
import {CompressionMethod} from './constants'
import {
  ArtifactCacheEntry,
  InternalCacheOptions,
  CommitCacheRequest,
  ReserveCacheRequest,
  ReserveCacheResponse,
  ITypedResponseWithError,
  ArtifactCacheList
} from './contracts'
import {
  downloadCacheHttpClient,
  downloadCacheHttpClientConcurrent,
  downloadCacheStorageSDK
} from './downloadUtils'
import {
  DownloadOptions,
  UploadOptions,
  getDownloadOptions,
  getUploadOptions
} from '../options'
import {
  isSuccessStatusCode,
  retryHttpClientResponse,
  retryTypedResponse
} from './requestUtils'

const versionSalt = '1.0'

function getCacheApiUrl(resource: string): string {
  const baseUrl: string = process.env['ACTIONS_CACHE_URL'] || ''
  if (!baseUrl) {
    throw new Error('Cache Service Url not found, unable to restore cache.')
  }

  const url = `${baseUrl}_apis/artifactcache/${resource}`
  core.debug(`Resource Url: ${url}`)
  return url
}

function createAcceptHeader(type: string, apiVersion: string): string {
  return `${type};api-version=${apiVersion}`
}

function getRequestOptions(): RequestOptions {
  const requestOptions: RequestOptions = {
    headers: {
      Accept: createAcceptHeader('application/json', '6.0-preview.1')
    }
  }

  return requestOptions
}

function createHttpClient(): HttpClient {
  const token = process.env['ACTIONS_RUNTIME_TOKEN'] || ''
  const bearerCredentialHandler = new BearerCredentialHandler(token)

  return new HttpClient(
    'actions/cache',
    [bearerCredentialHandler],
    getRequestOptions()
  )
}

export function getCacheVersion(
  paths: string[],
  compressionMethod?: CompressionMethod,
  enableCrossOsArchive = false
): string {
  // don't pass changes upstream
  const components = paths.slice()

  // Add compression method to cache version to restore
  // compressed cache as per compression method
  if (compressionMethod) {
    components.push(compressionMethod)
  }

  // Only check for windows platforms if enableCrossOsArchive is false
  if (process.platform === 'win32' && !enableCrossOsArchive) {
    components.push('windows-only')
  }

  // Add salt to cache version to support breaking changes in cache entry
  components.push(versionSalt)

  return crypto.createHash('sha256').update(components.join('|')).digest('hex')
}

export async function getCacheEntry(
  keys: string[],
  paths: string[],
  options?: InternalCacheOptions
): Promise<ArtifactCacheEntry | null> {
  const client = new TosClient({
    accessKeyId: process.env['ACCESS_KEY'] as string,
    accessKeySecret: process.env['SECRET_KEY'] as string,
    region: process.env['REGION'] as string
  })
  const version = getCacheVersion(
    paths,
    options?.compressionMethod,
    options?.enableCrossOsArchive
  )

  for (const key of keys) {
    const objectKey = `caches/${repo}/${ref}/${workflowHash}/${key}`
    try {
      console.warn(`>> objectKey: ${objectKey}`)
      await client.headObject({
        bucket: bucketName,
        key: objectKey
      })
      const entry: ArtifactCacheEntry = {
        cacheKey: key,
        cacheVersion: version, 
        objectKey: objectKey,
      }
      return entry
    } catch (error) {
      if (error instanceof TosServerError && error.statusCode === 404) {
        console.warn(`The object ${objectKey} doesn't exist.`)
      }
    }
  }
  const entry: ArtifactCacheEntry = {
    cacheVersion: version
  }
  console.warn(`unmatched keys ${keys}`)
  return entry
}

// export async function getCacheEntry(
//   keys: string[],
//   paths: string[],
//   options?: InternalCacheOptions
// ): Promise<ArtifactCacheEntry | null> {
//   const httpClient = createHttpClient()
//   const version = getCacheVersion(
//     paths,
//     options?.compressionMethod,
//     options?.enableCrossOsArchive
//   )
//   const resource = `cache?keys=${encodeURIComponent(
//     keys.join(',')
//   )}&version=${version}`

//   const response = await retryTypedResponse('getCacheEntry', async () =>
//     httpClient.getJson<ArtifactCacheEntry>(getCacheApiUrl(resource))
//   )
//   // Cache not found
//   if (response.statusCode === 204) {
//     // List cache for primary key only if cache miss occurs
//     if (core.isDebug()) {
//       await printCachesListForDiagnostics(keys[0], httpClient, version)
//     }
//     return null
//   }
//   if (!isSuccessStatusCode(response.statusCode)) {
//     throw new Error(`Cache service responded with ${response.statusCode}`)
//   }

//   const cacheResult = response.result
//   const cacheDownloadUrl = cacheResult?.archiveLocation
//   if (!cacheDownloadUrl) {
//     // Cache achiveLocation not found. This should never happen, and hence bail out.
//     throw new Error('Cache not found.')
//   }
//   core.setSecret(cacheDownloadUrl)
//   core.debug(`Cache Result:`)
//   core.debug(JSON.stringify(cacheResult))

//   return cacheResult
// }

async function printCachesListForDiagnostics(
  key: string,
  httpClient: HttpClient,
  version: string
): Promise<void> {
  const resource = `caches?key=${encodeURIComponent(key)}`
  const response = await retryTypedResponse('listCache', async () =>
    httpClient.getJson<ArtifactCacheList>(getCacheApiUrl(resource))
  )
  if (response.statusCode === 200) {
    const cacheListResult = response.result
    const totalCount = cacheListResult?.totalCount
    if (totalCount && totalCount > 0) {
      core.debug(
        `No matching cache found for cache key '${key}', version '${version} and scope ${process.env['GITHUB_REF']}. There exist one or more cache(s) with similar key but they have different version or scope. See more info on cache matching here: https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows#matching-a-cache-key \nOther caches with similar key:`
      )
      for (const cacheEntry of cacheListResult?.artifactCaches || []) {
        core.debug(
          `Cache Key: ${cacheEntry?.cacheKey}, Cache Version: ${cacheEntry?.cacheVersion}, Cache Scope: ${cacheEntry?.scope}, Cache Created: ${cacheEntry?.creationTime}`
        )
      }
    }
  }
}

export async function downloadCache(
  objectKey: string,
  archivePath: string,
  options?: DownloadOptions
): Promise<void> {
  const client = new TosClient({
    accessKeyId: process.env['ACCESS_KEY'] as string,
    accessKeySecret: process.env['SECRET_KEY'] as string,
    region: process.env['REGION'] as string
  })
  await client.getObjectToFile({
    bucket: bucketName,
    key: objectKey,
    filePath: archivePath
  })

  // const archiveUrl = new URL(objectKey)
  // const downloadOptions = getDownloadOptions(options)

  // if (archiveUrl.hostname.endsWith('.blob.core.windows.net')) {
  //   if (downloadOptions.useAzureSdk) {
  //     // Use Azure storage SDK to download caches hosted on Azure to improve speed and reliability.
  //     await downloadCacheStorageSDK(
  //       objectKey,
  //       archivePath,
  //       downloadOptions
  //     )
  //   } else if (downloadOptions.concurrentBlobDownloads) {
  //     // Use concurrent implementation with HttpClient to work around blob SDK issue
  //     await downloadCacheHttpClientConcurrent(
  //       objectKey,
  //       archivePath,
  //       downloadOptions
  //     )
  //   } else {
  //     // Otherwise, download using the Actions http-client.
  //     await downloadCacheHttpClient(objectKey, archivePath)
  //   }
  // } else {
  //   await downloadCacheHttpClient(objectKey, archivePath)
  // }
}

export async function reserveCache(
  key: string,
  paths: string[],
  options?: InternalCacheOptions
): Promise<ITypedResponseWithError<ReserveCacheResponse>> {
  const httpClient = createHttpClient()
  const version = getCacheVersion(
    paths,
    options?.compressionMethod,
    options?.enableCrossOsArchive
  )

  const reserveCacheRequest: ReserveCacheRequest = {
    key,
    version,
    cacheSize: options?.cacheSize
  }
  const response = await retryTypedResponse('reserveCache', async () =>
    httpClient.postJson<ReserveCacheResponse>(
      getCacheApiUrl('caches'),
      reserveCacheRequest
    )
  )
  return response
}

export async function reserveCacheVolc(
  key: string,
  paths: string[],
  options?: InternalCacheOptions
): Promise<ReserveCacheResponse> {
  const client = new TosClient({
    accessKeyId: process.env['ACCESS_KEY'] as string,
    accessKeySecret: process.env['SECRET_KEY'] as string,
    region: process.env['REGION'] as string
  })
  const version = getCacheVersion(
    paths,
    options?.compressionMethod,
    options?.enableCrossOsArchive
  )
  const cacheId = 1
  const response: ReserveCacheResponse = {
    cacheId: cacheId
  }
  return response
}

function getContentRange(start: number, end: number): string {
  // Format: `bytes start-end/filesize
  // start and end are inclusive
  // filesize can be *
  // For a 200 byte chunk starting at byte 0:
  // Content-Range: bytes 0-199/*
  return `bytes ${start}-${end}/*`
}

async function uploadChunk(
  httpClient: HttpClient,
  resourceUrl: string,
  openStream: () => NodeJS.ReadableStream,
  start: number,
  end: number
): Promise<void> {
  core.debug(
    `Uploading chunk of size ${
      end - start + 1
    } bytes at offset ${start} with content range: ${getContentRange(
      start,
      end
    )}`
  )
  const additionalHeaders = {
    'Content-Type': 'application/octet-stream',
    'Content-Range': getContentRange(start, end)
  }

  const uploadChunkResponse = await retryHttpClientResponse(
    `uploadChunk (start: ${start}, end: ${end})`,
    async () =>
      httpClient.sendStream(
        'PATCH',
        resourceUrl,
        openStream(),
        additionalHeaders
      )
  )

  if (!isSuccessStatusCode(uploadChunkResponse.message.statusCode)) {
    throw new Error(
      `Cache service responded with ${uploadChunkResponse.message.statusCode} during upload chunk.`
    )
  }
}

// async function uploadFile(
//   httpClient: HttpClient,
//   cacheId: number,
//   archivePath: string,
//   options?: UploadOptions
// ): Promise<void> {
//   // Upload Chunks
//   const fileSize = utils.getArchiveFileSizeInBytes(archivePath)
//   const resourceUrl = getCacheApiUrl(`caches/${cacheId.toString()}`)
//   const fd = fs.openSync(archivePath, 'r')
//   const uploadOptions = getUploadOptions(options)

//   const concurrency = utils.assertDefined(
//     'uploadConcurrency',
//     uploadOptions.uploadConcurrency
//   )
//   const maxChunkSize = utils.assertDefined(
//     'uploadChunkSize',
//     uploadOptions.uploadChunkSize
//   )

//   const parallelUploads = [...new Array(concurrency).keys()]
//   core.debug('Awaiting all uploads')
//   let offset = 0

//   try {
//     await Promise.all(
//       parallelUploads.map(async () => {
//         while (offset < fileSize) {
//           const chunkSize = Math.min(fileSize - offset, maxChunkSize)
//           const start = offset
//           const end = offset + chunkSize - 1
//           offset += maxChunkSize

//           await uploadChunk(
//             httpClient,
//             resourceUrl,
//             () =>
//               fs
//                 .createReadStream(archivePath, {
//                   fd,
//                   start,
//                   end,
//                   autoClose: false
//                 })
//                 .on('error', error => {
//                   throw new Error(
//                     `Cache upload failed because file read failed with ${error.message}`
//                   )
//                 }),
//             start,
//             end
//           )
//         }
//       })
//     )
//   } finally {
//     fs.closeSync(fd)
//   }
//   return
// }

function handleError(error) {
  if (error instanceof TosClientError) {
    console.log('Client Err Msg:', error.message);
    console.log('Client Err Stack:', error.stack);
  } else if (error instanceof TosServerError) {
    console.log('Request ID:', error.requestId);
    console.log('Response Status Code:', error.statusCode);
    console.log('Response Header:', error.headers);
    console.log('Response Err Code:', error.code);
    console.log('Response Err Msg:', error.message);
  } else {
    console.log('unexpected exception, message: ', error);
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
    // 上传对象
    await client.putObjectFromFile({
      bucket: bucketName,
      key: objectName,
      filePath: archivePath
    });
  } catch (error) {
    handleError(error);
  }
}

async function commitCache(
  httpClient: HttpClient,
  cacheId: number,
  filesize: number
): Promise<TypedResponse<null>> {
  const commitCacheRequest: CommitCacheRequest = {size: filesize}
  return await retryTypedResponse('commitCache', async () =>
    httpClient.postJson<null>(
      getCacheApiUrl(`caches/${cacheId.toString()}`),
      commitCacheRequest
    )
  )
}

import { TosClient, TosClientError, TosServerError } from '@volcengine/tos-sdk'

const bucketName = process.env['BUCKET_NAME'] // test-cache-action
const repo = process.env['GITHUB_REPOSITORY']
const workflowHash = process.env['GITHUB_WORKFLOW_SHA']
const ref = process.env['GITHUB_REF']

export async function saveCache(
  cacheId: string,
  archivePath: string,
  options?: UploadOptions
): Promise<void> {
  // setup volc object storage client.
  const client = new TosClient({
    accessKeyId: process.env['ACCESS_KEY'] as string,
    accessKeySecret: process.env['SECRET_KEY'] as string,
    region: process.env['REGION'] as string
  })

  core.debug('Upload cache')
  await uploadFile(client, cacheId, archivePath, options)

  // Commit Cache
  core.debug('Commiting cache')
  const cacheSize = utils.getArchiveFileSizeInBytes(archivePath)
  core.info(
    `Cache Size: ~${Math.round(cacheSize / (1024 * 1024))} MB (${cacheSize} B)`
  )

  // const commitCacheResponse = await commitCache(httpClient, cacheId, cacheSize)
  // if (!isSuccessStatusCode(commitCacheResponse.statusCode)) {
  //   throw new Error(
  //     `Cache service responded with ${commitCacheResponse.statusCode} during commit cache.`
  //   )
  // }

  core.info('Cache saved successfully')
}
