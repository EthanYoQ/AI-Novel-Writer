/** Canonical aliases shared by roster discovery and persistence normalization. */
export const CHARACTER_ARRAY_KEYS = [
  'characters', 'characterCards', 'character_cards', 'cards',
  '角色', '角色卡', '角色列表', '人物', '人物列表',
] as const

export const CHARACTER_FIELD_ALIASES = {
  name: ['name', '姓名', '角色名', '名字', '人物名称'],
  role: ['role', '定位', '角色定位', '类型'],
  gender: ['gender', '性别'],
  age: ['age', '年龄', '年龄段'],
  appearance: ['appearance', '外貌', '外貌特征', '外貌描写'],
  personality: ['personality', '性格', '性格特点', '性格特征'],
  background: ['background', '背景', '背景故事', '身世'],
  abilities: ['abilities', 'ability', '能力', '技能', '能力/技能', '能力技能'],
  motivation: ['motivation', '动机', '动力', '核心动机', '核心动机与渴望'],
  relationships: ['relationships', 'relations', '关系网', '角色关系', '关系'],
  arc: ['arc', '角色弧光', '成长轨迹', '成长线'],
  notes: ['notes', '备注', '其他补充说明', '补充'],
  currentState: ['currentState', 'current_state', '当前状态', '状态'],
} as const

export const RELATIONSHIP_TARGET_ALIASES = ['target', 'name', 'to', 'character', '角色', '对象', '目标'] as const
export const RELATIONSHIP_LABEL_ALIASES = ['relation', 'label', 'type', '关系', '关系类型', '描述'] as const
