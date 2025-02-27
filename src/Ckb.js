//@flow

import type Transport from "@ledgerhq/hw-transport";
import BIPPath from "bip32-path";
import * as blockchain from "./annotated";
import Blake2b from "blake2b-wasm";
import { bech32m } from "bech32";

// CKB address is longer than the longest Bitcoin address
// The bech32m encoding limit should be increased
const BECH32_LIMIT = 1023;

// APDU command constants
const CLA = 0x80;                  // Command class (Nervos app)

// Instruction codes
// defined at https://github.com/LedgerHQ/app-nervos/blob/develop/src/apdu.h#L21
const INS_GET_CONFIG = 0x00;       // Get app configuration
const INS_GET_WALLET_ID = 0x01;    // Get wallet identifier
const INS_GET_PUBLIC_KEY = 0x02;   // Get wallet public key
const INS_SIGN_TX = 0x03;          // Sign transaction
const INS_GET_EXTENDED_PUBKEY = 0x04; // Get extended public key
const INS_SIGN_MSG = 0x06;         // Sign message
const INS_GET_APP_HASH = 0x09;     // Get app hash

// Parameter 1 (P1) values
// defined at https://github.com/LedgerHQ/app-nervos/blob/develop/src/apdu_sign.c#L968
const P1_INIT = 0x00;              // Initialization
const P1_CONTINUE = 0x01;          // Continuation
const P1_LAST_MARKER = 0x80;       // Last chunk flag
const P1_FINAL = 0x81;             // Final chunk (CONTINUE | LAST_MARKER)

// Parameter 2 (P2) values
const P2_DEFAULT = 0x00;           // Default P2 value

// Other constants
const MAX_APDU_SIZE = 230;         // Maximum data size per APDU
const SIGNATURE_SIZE = 65;         // Size of the returned signature (r, s, v)

/**
 * Nervos API
 *
 * @example
 * import Ckb from "@obsidiansystems/hw-app-ckb";
 * const ckb = new Ckb(transport);
 */
export default class Ckb {
  transport: Transport<*>;

  constructor(transport: Transport<*>, scrambleKey: string = "CKB") {
    this.transport = transport;
    transport.decorateAppAPIMethods(
      this,
      [
        "getAppConfiguration",
        "getWalletId",
        "getWalletPublicKey",
        "signAnnotatedTransaction",
      ],
      scrambleKey
    );
  }

  /**
   * get CKB address for a given BIP 32 path.
   *
   * @param path a path in BIP 32 format
   * @return an object with a publicKey, lockArg, and (secp256k1+blake160) address.
   * @example
   * const result = await ckb.getWalletPublicKey("44'/144'/0'/0/0");
   * const publicKey = result.publicKey;
   * const lockArg = result.lockArg;
   * const address = result.address;
   */
  async getWalletPublicKey(path: string, testnet: boolean): Promise<string> {
    const bipPath = BIPPath.fromString(path).toPathArray();

    const data = Buffer.alloc(1 + bipPath.length * 4);

    data.writeUInt8(bipPath.length, 0);
    bipPath.forEach((segment, index) => {
      data.writeUInt32BE(segment, 1 + index * 4);
    });

    const response = await this.transport.send(CLA, INS_GET_PUBLIC_KEY, P1_INIT, P2_DEFAULT, data);

    const publicKeyLength = response[0];
    const publicKey = response.slice(1, 1 + publicKeyLength);

    const compressedPublicKey = Buffer.alloc(33);
    compressedPublicKey.fill(publicKey[64] & 1 ? "03" : "02", 0, 1, "hex");
    compressedPublicKey.fill(publicKey.subarray(1, 33), 1, 33);
    const hashPersonalization = Uint8Array.from([99, 107, 98, 45, 100, 101, 102, 97, 117, 108, 116, 45, 104, 97, 115, 104]);
    const lockArg = Buffer.from(
      Blake2b(32, null, null, hashPersonalization)
        .update(compressedPublicKey)
        .digest("binary")
        .subarray(0, 20)
    );

    const addr_contents: number[] = [
      // CKB 2021 address full format prefix
      0x00,
      // SECP256K1_BLAKE160 code hash
      ...[
        155, 215, 224, 111,  62, 207, 75,
        224, 242, 252, 210,  24, 139, 35,
        241, 185, 252, 200, 142,  93, 75,
        101, 168,  99, 123,  23, 114, 59,
        189, 163, 204, 232
      ],
      // SECP256K1_BLAKE160 hash type
      0b00000001,
      // lock args
      ...lockArg
    ];
    const addr = bech32m.encode(
      testnet ? "ckt" : "ckb",
      bech32m.toWords(addr_contents),
      BECH32_LIMIT
    );

    return {
      publicKey: publicKey.toString("hex"),
      lockArg: lockArg.toString("hex"),
      address: addr,
    };
  }

  /**
   * get extended public key for a given BIP 32 path.
   *
   * @param path a path in BIP 32 format
   * @return an object with a publicKey
   * @example
   * const result = await ckb.getWalletPublicKey("44'/144'/0'/0/0");
   * const publicKey = result;
   */
  async getWalletExtendedPublicKey(path: string): Promise<string> {
    const bipPath = BIPPath.fromString(path).toPathArray();

    const cla = 0x80;
    const ins = 0x04;
    const p1 = 0x00;
    const p2 = 0x00;
    const data = Buffer.alloc(1 + bipPath.length * 4);

    data.writeUInt8(bipPath.length, 0);
    bipPath.forEach((segment, index) => {
      data.writeUInt32BE(segment, 1 + index * 4);
    });

    const response = await this.transport.send(cla, ins, p1, p2, data);
    const publicKeyLength = response[0];
    const chainCodeOffset = 2 + publicKeyLength;
    const chainCodeLength = response[1 + publicKeyLength];
    return {
      public_key: response.slice(1, 1 + publicKeyLength).toString("hex"),
      chain_code: response
        .slice(chainCodeOffset, chainCodeOffset + chainCodeLength)
        .toString("hex"),
    };
  }

  /**
   * Sign a Nervos transaction with a given BIP 32 path
   *
   * @param signPath the path to sign with, in BIP 32 format
   * @param rawTxHex transaction to sign
   * @param groupWitnessesHex hex of in-group and extra witnesses to include in signature
   * @param contextTransaction list of transaction contexts for parsing
   * @param changePath the path the transaction sends change to, in BIP 32 format (optional, defaults to signPath)
   * @return a signature as hex string
   * @example
   * TODO
   */

  async signTransaction(
    signPath: string | BIPPath | [number],
    rawTx: string | blockchain.RawTransactionJSON,
    groupWitnessesHex?: [string],
    rawContextsTx: [string | blockchain.RawTransactionJSON],
    changePath: string | BIPPath | [number]
  ): Promise<string> {
    return await this.signAnnotatedTransaction(
      this.buildAnnotatedTransaction(
        signPath,
        rawTx,
        groupWitnessesHex,
        rawContextsTx,
        changePath
      )
    );
  }

  /**
   * Construct an AnnotatedTransaction for a given collection of signing data
   *
   * Parameters are the same as for signTransaction, but no ledger interaction is attempted.
   *
   * AnnotatedTransaction is a type defined for the ledger app that collects
   * all of the information needed to securely confirm a transaction on-screen
   * and a few bits of duplicative information to allow it to be processed as a
   * stream.
   */

  buildAnnotatedTransaction(
    signPath: string | BIPPath | [number],
    rawTx: string | RawTransactionJSON,
    groupWitnesses?: [string],
    rawContextsTx: [string | RawTransactionJSON],
    changePath: string | BIPPath | [number]
  ): AnnotatedTransactionJSON {
    const prepBipPath = (pathSrc) => {
      if (Array.isArray(pathSrc)) {
        return pathSrc;
      }
      if (typeof pathSrc === "object") {
        return pathSrc.toPathArray();
      }
      if (typeof pathSrc === "string") {
        return BIPPath.fromString(pathSrc).toPathArray();
      }
    };

    const signBipPath = prepBipPath(signPath);
    const changeBipPath = prepBipPath(changePath);

    const getRawTransactionJSON = (rawTrans) => {
      if (typeof rawTrans === "string") {
        const rawTxBuffer = Buffer.from(rawTrans, "hex");
        return new blockchain.RawTransaction(rawTxBuffer.buffer).toObject();
      }
      return rawTrans;
    };

    const contextTransactions = rawContextsTx.map(getRawTransactionJSON);

    const rawTxUnpacked = getRawTransactionJSON(rawTx);

    const annotatedCellInputVec = rawTxUnpacked.inputs.map((inpt, idx) => ({
      input: inpt,
      source: contextTransactions[idx],
    }));

    const annotatedRawTransaction = {
      version: rawTxUnpacked.version,
      cell_deps: rawTxUnpacked.cell_deps,
      header_deps: rawTxUnpacked.header_deps,
      inputs: annotatedCellInputVec,
      outputs: rawTxUnpacked.outputs,
      outputs_data: rawTxUnpacked.outputs_data,
    };

    return {
      signPath: signBipPath,
      changePath: changeBipPath,
      inputCount: rawTxUnpacked.inputs.length,
      raw: annotatedRawTransaction,
      witnesses:
        Array.isArray(groupWitnesses) && groupWitnesses.length > 0
          ? groupWitnesses
          : [this.defaultSighashWitness],
    };
  }

  /**
   * Sign an already constructed AnnotatedTransaction.
   */
  async signAnnotatedTransaction(
    tx: AnnotatedTransaction | AnnotatedTransactionJSON
  ): Promise<string> {
    const rawAnTx = Buffer.from(blockchain.SerializeAnnotatedTransaction(tx));

    const maxApduSize = 230;

    let txFullChunks = Math.floor(rawAnTx.byteLength / maxApduSize);
    let isContinuation = 0x00;
    for (let i = 0; i < txFullChunks; i++) {
      let data = rawAnTx.slice(i * maxApduSize, (i + 1) * maxApduSize);
      await this.transport.send(0x80, 0x03, isContinuation, 0x00, data);
      isContinuation = 0x01;
    }

    let lastOffset = txFullChunks * maxApduSize;
    let lastData = rawAnTx.slice(lastOffset, lastOffset + maxApduSize);
    let response = await this.transport.send(
      0x80,
      0x03,
      isContinuation | 0x80,
      0x00,
      lastData
    );
    return response.slice(0,65).toString("hex");
  }

  /**
   * An empty WitnessArgs with enough space to fit a sighash signature into.
   */
  defaultSighashWitness =
    "55000000100000005500000055000000410000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000";

  /**
   * Get the version of the Nervos app installed on the hardware device
   *
   * @return an object with a version
   * @example
   * const result = await ckb.getAppConfiguration();
   *
   * {
   *   "version": "1.0.3",
   *   "hash": "0000000000000000000000000000000000000000"
   * }
   */
  async getAppConfiguration(): Promise<{
    version: string,
    hash: string,
  }> {
    const response1 = await this.transport.send(CLA, INS_GET_CONFIG, P1_INIT, P2_DEFAULT);
    const response2 = await this.transport.send(CLA, INS_GET_APP_HASH, P1_INIT, P2_DEFAULT);
    return {
      version: "" + response1[0] + "." + response1[1] + "." + response1[2],
      hash: response2.slice(0, -3).toString("latin1") // last 3 bytes should be 0x009000
    };
  }

  /**
   * Get the wallet identifier for the Ledger wallet
   *
   * @return a byte string
   * @example
   * const id = await ckb.getWalletId();
   *
   * "0x69c46b6dd072a2693378ef4f5f35dcd82f826dc1fdcc891255db5870f54b06e6"
   */
  async getWalletId(): Promise<string> {
    const response = await this.transport.send(
      CLA, 
      INS_GET_WALLET_ID, 
      P1_INIT, 
      P2_DEFAULT
    );

    const result = response.slice(0, 32).toString("hex");

    return result;
  }

  /**
   * Sign a message with the Ledger device using a specific BIP32 path
   * 
   * @param {string} path - BIP32 path to derive the key for signing (e.g. "44'/309'/0'/0/0")
   * @param {string} rawMsgHex - Hex string of the message to be signed
   * @param {boolean} displayHex - Whether to display the message as hex (true) or as text (false) on the device
   * @return {string} - Hex string of the signature (65 bytes: r, s, v components)
   * @example
   * const signature = await ckb.signMessage("44'/309'/0'/0/0", "48656c6c6f20776f726c64", false);
   */
  async signMessage(
    path: string,
    rawMsgHex: string,
    displayHex: bool
  ): Promise<string> {
    // Convert BIP32 path string to array of integers
    const bipPath = BIPPath.fromString(path).toPathArray();
    
    // Prepend "Nervos Message:" to prevent message signing from being used to sign transactions
    // This is a security measure known as "domain separation"
    const magicBytes = Buffer.from("Nervos Message:");
    const rawMsg = Buffer.concat([magicBytes, Buffer.from(rawMsgHex, "hex")]);

    // Step 1: Send initialization APDU with BIP path and display preferences
    // Format: [displayHex(1), pathLength(1), path(4*pathLength)]
    let rawPath = Buffer.alloc(1 + 1 + bipPath.length * 4);
    rawPath.writeInt8(displayHex, 0);                // First byte: display as hex flag
    rawPath.writeInt8(bipPath.length, 1);            // Second byte: number of path components
    bipPath.forEach((segment, index) => {
      rawPath.writeUInt32BE(segment, 2 + index * 4); // Following bytes: path components (4 bytes each)
    });
    
    // Send initialization command to the device
    await this.transport.send(
      CLA, 
      INS_SIGN_MSG, 
      P1_INIT, 
      P2_DEFAULT, 
      rawPath
    );

    // Step 2: Send message data in chunks due to APDU size limitations
    const fullChunksCount = Math.floor(rawMsg.length / MAX_APDU_SIZE);
    
    // Send all complete chunks except the last one
    for (let i = 0; i < fullChunksCount; i++) {
      const chunkStart = i * MAX_APDU_SIZE;
      const chunkEnd = (i + 1) * MAX_APDU_SIZE;
      const chunkData = rawMsg.slice(chunkStart, chunkEnd);
      
      // Send continuation APDU with chunk data
      await this.transport.send(
        CLA, 
        INS_SIGN_MSG, 
        P1_CONTINUE, 
        P2_DEFAULT, 
        chunkData
      );
    }

    // Step 3: Send the final chunk and receive the signature
    const lastChunkOffset = fullChunksCount * MAX_APDU_SIZE;
    const lastChunkData = rawMsg.slice(lastChunkOffset);
    
    // Send final chunk with the "last chunk" flag set
    const response = await this.transport.send(
      CLA, 
      INS_SIGN_MSG, 
      P1_FINAL,     // 0x81 = 0x01 (continue) | 0x80 (last chunk)
      P2_DEFAULT, 
      lastChunkData
    );
    
    // Extract and return the signature (first 65 bytes of the response)
    return response.slice(0, SIGNATURE_SIZE).toString("hex");
  }

}

