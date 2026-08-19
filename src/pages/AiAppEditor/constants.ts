import type { BlockRule } from '../../../electron/shared/block-rules.types';

export const EMPTY_RULE_DRAFT: Omit<BlockRule, 'id' | 'builtin'> = {
  domainPattern: '*',
  type: 'css',
  selector: '',
  jsCode: '',
  label: '',
  enabled: true,
};
