export type CategoryNode = {
  code: string;
  name: string;
  parent: string | null;
  sort: number;
  hidden?: boolean;
};

export type ClassifierRule = {
  pattern: RegExp;
  category: string;
};

export type SpecializationBlock = {
  whenCategory: string;
  matchField: 'name' | 'body';
  rules: ClassifierRule[];
};

export type ClassifierSpec = {
  appType: string;
  defaultWhenNoMatch: string;
  categories: CategoryNode[];
  rules: ClassifierRule[];
  specialization?: SpecializationBlock[];
};

export type ClassifyInput = { name?: string | null; body?: string | null };
export type Classifier = (input: ClassifyInput) => string;
