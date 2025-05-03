const html = require('eslint-plugin-html');
const globals = require('globals');
const js = require('@eslint/js');

const {
	FlatCompat,
} = require('@eslint/eslintrc');

const compat = new FlatCompat({
	baseDirectory: __dirname,
	recommendedConfig: js.configs.recommended,
	allConfig: js.configs.all
});

module.exports = [...compat.extends('eslint:recommended'), {
	plugins: {
		html,
	},

	languageOptions: {
		globals: {
			...globals.node,
			...globals.mocha,
			...globals.jquery,
		},

		ecmaVersion: 2020,
		sourceType: 'commonjs',
	},

	rules: {
		indent: ['error', 'tab', {
			SwitchCase: 1,
		}],

		'no-console': 'off',
		'no-trailing-spaces': 'error',
		'no-var': 'error',

		'no-unused-vars': ['error', {
				ignoreRestSiblings: true,
				argsIgnorePattern: '^_',
		}],

		'prefer-const': 'error',

		quotes: ['error', 'single', {
			avoidEscape: true,
			allowTemplateLiterals: true,
		}],

		semi: ['error', 'always'],
	},
}];