-- Step 1: Add the new '220' value to the concrete_thickness enum
ALTER TYPE concrete_thickness ADD VALUE IF NOT EXISTS '220';