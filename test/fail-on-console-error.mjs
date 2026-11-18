import { deepEqual } from 'node:assert/strict';
import { after } from 'node:test';
import { format } from 'node:util';

const errors = [];
const originalError = console.error;

console.error = (...args) => {
    errors.push(format(...args));
    originalError.apply(console, args);
};

after(() => {
    console.error = originalError;
    deepEqual(errors, [], 'Unexpected console errors');
});
