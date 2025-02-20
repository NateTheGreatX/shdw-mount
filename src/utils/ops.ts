import pathTools from "path";
import { NodeFile } from "./NodeFile";
import { calculateTransferRate } from "./index";
import * as fuse from "@cocalc/fuse-native";

export const getOps = ({bucketId, fileBuffer, sdk, invalidateCache, uploadChunkTask, completeLargeFile}) => ({
  flush: async (path, fd, cb) => {
    // This could signal the end of writes. Combine all buffers and upload
    try {
      if (fileBuffer[path] && !fileBuffer[path].isLarge) { // handle finishing the uploads that are not chunked
        try {
          // No need to concat since fileBuffer[path] is already one buffer
          const fullBuffer = fileBuffer[path].buffer;
          const fileName = pathTools.basename(path);
          const relativePath = pathTools.dirname(path).slice(1);
          const file = new NodeFile(fullBuffer, fileName);
          await sdk.uploadFile(bucketId, file, {directory: relativePath});
          invalidateCache();
        } catch (uploadError) {
          console.error('Error uploading file:', uploadError);
          // Handle upload errors appropriately
        } finally {
          delete fileBuffer[path]; // Clean up regardless of success or failure
        }
        process.nextTick(cb, 0); // Signal flush is done
      } else if (fileBuffer[path] && fileBuffer[path].isLarge) {
        // send any leftover buffer and send complete message to server
        console.log('Uploading last chunk');
        if (fileBuffer[path].buffer.length > 0) {
          const lastChunkTask = uploadChunkTask({
            uploadId: fileBuffer[path].uploadId,
            key: fileBuffer[path].key, path, chunk: fileBuffer[path].buffer,
            partNumber: fileBuffer[path].chunkNumber + 1,
            fileName: pathTools.basename(path)
          });
          fileBuffer[path].uploadedPartsTasks.push(lastChunkTask);
        }
        console.log('Waiting for all async parts to upload');
        const partTasks = await Promise.all(fileBuffer[path].uploadedPartsTasks);
        const parts = await Promise.all(partTasks);
        console.log('All parts uploaded', parts);
        const timeEnd = Date.now();
        const timeTaken = timeEnd - fileBuffer[path].timeStarted;
        const copiedBytes = fileBuffer[path].buffer.length + (5 * 1024 * 1024 * (fileBuffer[path].chunkNumber));
        const mbPerSecond = calculateTransferRate({timeTaken, buffer: {length: copiedBytes}})
        // display transfer speed in MB/s to the 3rd decimal place
        console.log(`Time taken:${timeTaken / 1000} seconds, Transfer rate: ${mbPerSecond.toFixed(3)} MB/s`);
        process.nextTick(cb, 0);
        console.log('sending completion msg')
        const response = await completeLargeFile({
          uploadId: fileBuffer[path].uploadId,
          key: fileBuffer[path].key,
          uploadedParts: parts
        });
        console.log(response);
        delete fileBuffer[path];
        // cb(0);
        invalidateCache();
      } else {
        cb(0); // No data was written, or already flushed
      }
    } catch (error) {
      console.error('Error in flush:', error);
      cb(fuse.default.EIO); // or another appropriate error code
    }
  }
})