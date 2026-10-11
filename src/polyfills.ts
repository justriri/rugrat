import 'react-native-get-random-values';
import { Buffer } from 'buffer';

// @solana/web3.js expects a global Buffer. This module is imported first, before anything uses it.
(globalThis as { Buffer?: typeof Buffer }).Buffer = Buffer;
