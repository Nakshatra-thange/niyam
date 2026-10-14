import type { LenderRuleset } from "./schema.js";

/**
 * Hand-written rules for 5 fictional lenders. On Day 4 the policy agent
 * will generate these from PDFs instead; these become the "expected answers"
 * for the eval harness.
 */
export const SEED_RULESETS: LenderRuleset[] = [
  {
    lenderId: "suvidha",
    lenderName: "Suvidha Finance",
    interestRateMin: 11.5,
    interestRateMax: 18,
    rules: [
      { id: "suv-cibil", field: "cibil_score", op: "gte", value: 750, message: "Requires a CIBIL score of 750 or above" },
      { id: "suv-income", field: "monthly_income", op: "gte", value: 30000, message: "Requires monthly income of at least ₹30,000" },
      { id: "suv-emp", field: "employment_type", op: "eq", value: "salaried", message: "Lends to salaried applicants only" },
      { id: "suv-age", field: "age", op: "between", value: [21, 58], message: "Applicant age must be between 21 and 58" },
      { id: "suv-foir", field: "foir", op: "lte", value: 0.5, message: "Existing EMIs must be at most 50% of income" },
      { id: "suv-amt", field: "loan_amount", op: "between", value: [50000, 1500000], message: "Loan amount must be ₹50,000 to ₹15,00,000" },
    ],
  },
  {
    lenderId: "dhanrekha",
    lenderName: "Dhanrekha Capital",
    interestRateMin: 14,
    interestRateMax: 24,
    rules: [
      { id: "dhn-cibil", field: "cibil_score", op: "gte", value: 680, message: "Requires a CIBIL score of 680 or above" },
      { id: "dhn-income", field: "monthly_income", op: "gte", value: 20000, message: "Requires monthly income of at least ₹20,000" },
      { id: "dhn-age", field: "age", op: "between", value: [23, 60], message: "Applicant age must be between 23 and 60" },
      { id: "dhn-foir", field: "foir", op: "lte", value: 0.6, message: "Existing EMIs must be at most 60% of income" },
      { id: "dhn-amt", field: "loan_amount", op: "lte", value: 800000, message: "Maximum loan amount is ₹8,00,000" },
    ],
  },
  {
    lenderId: "kirana-credit",
    lenderName: "Kirana Credit NBFC",
    interestRateMin: 18,
    interestRateMax: 30,
    rules: [
      { id: "kir-emp", field: "employment_type", op: "in", value: ["self_employed", "business_owner"], message: "Lends to shop owners and self-employed only" },
      { id: "kir-vintage", field: "business_vintage_months", op: "gte", value: 12, message: "Business must be at least 12 months old" },
      { id: "kir-income", field: "monthly_income", op: "gte", value: 15000, message: "Requires monthly income of at least ₹15,000" },
      { id: "kir-amt", field: "loan_amount", op: "between", value: [10000, 300000], message: "Loan amount must be ₹10,000 to ₹3,00,000" },
      { id: "kir-age", field: "age", op: "between", value: [21, 65], message: "Applicant age must be between 21 and 65" },
    ],
  },
  {
    lenderId: "metro-bank",
    lenderName: "Metro Small Finance Bank",
    interestRateMin: 10.5,
    interestRateMax: 16,
    rules: [
      { id: "met-cibil", field: "cibil_score", op: "gte", value: 780, message: "Requires a CIBIL score of 780 or above" },
      { id: "met-income", field: "monthly_income", op: "gte", value: 50000, message: "Requires monthly income of at least ₹50,000" },
      { id: "met-city", field: "city", op: "in", value: ["mumbai", "delhi", "bengaluru", "hyderabad", "pune", "chennai"], message: "Available in metro cities only" },
      { id: "met-foir", field: "foir", op: "lte", value: 0.4, message: "Existing EMIs must be at most 40% of income" },
      { id: "met-amt", field: "loan_amount", op: "between", value: [100000, 2500000], message: "Loan amount must be ₹1,00,000 to ₹25,00,000" },
    ],
  },
  {
    lenderId: "pragati",
    lenderName: "Pragati Microfin",
    interestRateMin: 20,
    interestRateMax: 32,
    rules: [
      { id: "pra-income", field: "monthly_income", op: "gte", value: 10000, message: "Requires monthly income of at least ₹10,000" },
      { id: "pra-age", field: "age", op: "between", value: [21, 60], message: "Applicant age must be between 21 and 60" },
      { id: "pra-amt", field: "loan_amount", op: "lte", value: 150000, message: "Maximum loan amount is ₹1,50,000" },
      { id: "pra-city", field: "city", op: "not_in", value: ["mumbai", "delhi"], message: "Not available in Mumbai or Delhi" },
    ],
  },
];