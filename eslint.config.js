// @ts-check
import tseslint from 'typescript-eslint';

/**
 * THE PURITY GUARD.
 *
 * PRD §0 calls this the #1 architectural rule and §12/M1 states it as an
 * acceptance criterion — but a criterion nothing enforces is a comment. These
 * rules are the enforcement. If they are green, `packages/sim` is portable.
 *
 * The Math.* ban is the non-obvious half. ECMAScript leaves sin/cos/tan/atan2/
 * pow/exp/log "implementation-approximated": V8, SpiderMonkey and JSC do not
 * agree bit-for-bit, and neither do V8 versions with each other. One ULP flips
 * an `if (t < eps)` branch in collide-and-slide, and the divergence is
 * macroscopic within a single tick. `+ - * / %` are spec-mandated
 * round-to-nearest-even and FMA contraction is spec-illegal, so basic
 * arithmetic IS portable. Math.sqrt lowers to the hardware instruction and is
 * correctly rounded everywhere that ships. Everything else goes through
 * packages/sim/src/mathd.ts.
 */
const SIM_BANNED_MATH = [
  'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2',
  'pow', 'exp', 'expm1', 'log', 'log2', 'log10', 'log1p',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'cbrt', 'hypot', 'random',
];
// Deliberately NOT banned, because ECMAScript specifies each of these exactly
// and every engine must produce identical bits: Math.imul (32-bit integer
// multiply — rng.ts depends on it), Math.clz32, Math.fround, and
// abs/min/max/floor/ceil/round/trunc/sign/sqrt.

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/*.d.ts'] },

  ...tseslint.configs.recommended,

  // ---------------------------------------------------------------------------
  // packages/sim — PURE. No DOM, no THREE, no wall clock, no unportable math.
  // ---------------------------------------------------------------------------
  {
    files: ['packages/sim/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['three', 'three/*'], message: 'packages/sim must never import THREE. Render state, do not render in it.' },
          { group: ['@ovrrun/client', '@ovrrun/client/*'], message: 'sim cannot depend on the client. Dependencies point inward.' },
          { group: ['node:*', 'fs', 'path', 'os', 'crypto'], message: 'packages/sim must run identically in Node, a Worker and a browser. No host APIs.' },
        ],
      }],

      'no-restricted-globals': ['error',
        { name: 'window', message: 'packages/sim must never touch the DOM.' },
        { name: 'document', message: 'packages/sim must never touch the DOM.' },
        { name: 'navigator', message: 'packages/sim must never touch the DOM.' },
        { name: 'performance', message: 'No wall-clock time in sim. Use state.tick.' },
        { name: 'requestAnimationFrame', message: 'The sim runs on a fixed timestep, never a frame callback.' },
      ],

      'no-restricted-properties': ['error',
        ...SIM_BANNED_MATH.map((m) => ({
          object: 'Math',
          property: m,
          message: `Math.${m} is implementation-approximated and differs across JS engines. Use mathd.ts.`,
        })),
        { object: 'Date', property: 'now', message: 'No wall-clock time in sim. Use state.tick.' },
      ],

      'no-restricted-syntax': ['error',
        {
          selector: 'BinaryExpression[operator="**"]',
          message: 'The ** operator lowers to Math.pow and is not portable. Multiply, or use mathd.pow.',
        },
        {
          selector: 'AssignmentExpression[operator="**="]',
          message: 'The **= operator lowers to Math.pow and is not portable.',
        },
        {
          selector: 'NewExpression[callee.name="Date"]',
          message: 'No wall-clock time in sim. Use state.tick.',
        },
      ],
    },
  },

  // mathd.ts is the one file allowed to be the exception — it IS the replacement.
  // It still may not call the banned functions; it implements them. The ban stays
  // on, deliberately: if mathd ever calls Math.sin, the whole guard is theatre.

  // ---------------------------------------------------------------------------
  // Everything else: normal rules.
  // ---------------------------------------------------------------------------
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
);
