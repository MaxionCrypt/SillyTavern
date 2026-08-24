import { getPipeline } from '../transformers.js';
const TASK = 'feature-extraction';

/**
 * Gets the vectorized text in form of an array of numbers.
 * @param {string} text - The text to vectorize
 * @param {string} [model] - Optional Hugging Face model id
 * @returns {Promise<number[]>} - The vectorized text in form of an array of numbers
 */
export async function getTransformersVector(text, model = '') {
    const pipe = await getPipeline(TASK, model);
    const result = await pipe(text, { pooling: 'mean', normalize: true });
    const vector = Array.from(result.data);
    return vector;
}

/**
 * Gets the vectorized texts in form of an array of arrays of numbers.
 * @param {string[]} texts - The texts to vectorize
 * @param {string} [model] - Optional Hugging Face model id
 * @returns {Promise<number[][]>} - The vectorized texts in form of an array of arrays of numbers
 */
export async function getTransformersBatchVector(texts, model = '') {
    const result = [];
    for (const text of texts) {
        result.push(await getTransformersVector(text, model));
    }
    return result;
}
