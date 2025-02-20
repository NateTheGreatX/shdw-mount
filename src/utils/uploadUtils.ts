import { Semaphore } from "./Semaphore";
import { getSigner, signMessage } from "@shdwdrive/sdk/dist/utils/signing";
import { DEFAULT_ENDPOINT } from "@shdwdrive/sdk/dist/utils/constants";
import { sleep } from "./index";

export class UploadUtils {
  private semaphore: Semaphore;
  private keypair: any;
  private bucketId: any;

  constructor({maxConcurrency=5, keypair, bucketId}) {
    this.semaphore = new Semaphore(maxConcurrency);
    this.keypair = keypair;
    this.bucketId = bucketId;
  }
  private uploadChunk = async ({uploadId, key, path, chunk, partNumber, fileName}) => {

    const signer = getSigner(undefined, this.keypair);

    const formData = new FormData();
    formData.append('file', new Blob([chunk]), fileName);
    formData.append('bucket', this.bucketId);
    formData.append('uploadId', uploadId);
    formData.append('partNumber', partNumber.toString());
    formData.append('key', key);
    formData.append('signer', signer);

    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        await sleep(1000 * attempt + 1);
        const response = await fetch(`${DEFAULT_ENDPOINT}/v1/object/multipart/upload-part`, {
          method: 'POST',
          body: formData,
        });

        if (!response.ok) {
          throw new Error(`Failed to upload chunk: ${response.statusText}`);
        }

        const {ETag, PartNumber} = await response.json();
        return {ETag, PartNumber};
      } catch (error: any) {
        if (error.cause && error.cause.code === 'ECONNRESET') {
          attempt++;
          console.warn(`Retrying upload chunk ${partNumber} due to connection reset (attempt ${attempt}/${maxRetries})`);
          if (attempt >= maxRetries) {
            throw new Error(`Failed to upload chunk after ${maxRetries} attempts: ${error.message}`);
          }
        } else {
          throw error;
        }
      }
    }
  }

  createLargeFile = async ({directory = '', file}) => {
    // copy create routine from uploadLargeFile
    const cleanDirectory = directory
        .replace(/^\/+/, '')  // Remove leading slashes
        .replace(/\/+/g, '/') // Normalize multiple slashes to single
        .replace(/\/*$/, '/'); // Ensure single trailing slash

    // Create the full path with proper folder structure
    const fullPath = cleanDirectory ? `${cleanDirectory}${file.name}` : file.name;

    // Use just the filename for hash calculation to match server behavior
    const initMessage = `Shadow Drive Signed Message:\nInitialize multipart upload\nBucket: ${this.bucketId}\nFilename: ${file.name}\nFile size: ${file.size}`;

    const signature = await signMessage(initMessage, undefined, this.keypair);
    const signer = getSigner(undefined, this.keypair);

    const initResponse = await fetch(
        `${DEFAULT_ENDPOINT}/v1/object/multipart/create`,
        {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            bucket: this.bucketId,
            filename: file.name,
            message: signature,
            signer,
            size: file.size,
            file_type: file.type,
            directory: cleanDirectory,
            name: file.name,
            full_path: fullPath
          }),
        }
    );
    if (!initResponse.ok) {
      const error = await initResponse.json();
      throw new Error(error.error || 'Failed to initialize multipart upload');
    }

    const {uploadId, key} = await initResponse.json();
    // store uploadId and key in memory
    return {uploadId, key, signer, signature};
  }

  completeLargeFile = async ({uploadId, key, uploadedParts}) => {
    const signer = getSigner(undefined, this.keypair);
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries) {
      try {
        // Complete multipart upload
        const completeResponse = await fetch(
            `${DEFAULT_ENDPOINT}/v1/object/multipart/complete`,
            {
              method: 'POST',
              headers: {'Content-Type': 'application/json'},
              body: JSON.stringify({
                bucket: this.bucketId,
                uploadId,
                key,
                parts: uploadedParts,
                signer,
              }),
            }
        );

        if (!completeResponse.ok) {
          const error = await completeResponse.json();
          throw new Error(error.error || 'Failed to complete multipart upload');
        }

        try {
          const result = await completeResponse.json();
          return result;
        } catch (e) {
          throw e;
        }
      } catch (error: any) {
        attempt++;
        console.warn(`Retrying complete multipart upload (attempt ${attempt}/${maxRetries})`);
        if (attempt >= maxRetries) {
          throw new Error(`Failed to complete multipart upload after ${maxRetries} attempts: ${error.message}`);
        }
      }
    }
  };

  uploadChunkTask = async ({uploadId, key, path, chunk, partNumber, fileName}) => {
    console.log('pending chunk:', partNumber);
    await this.semaphore.acquire();
    console.log('Uploading chunk:', partNumber);
    try {
      return await this.uploadChunk({uploadId, key, path, chunk, partNumber, fileName});
    } finally {
      this.semaphore.release();
    }
  };

}