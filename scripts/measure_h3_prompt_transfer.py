"""Measure BF16 adherence after selecting prompts by their INT8 scores."""

import argparse
from collections import defaultdict
import csv
import json
from pathlib import Path

CHECKS = ("subjects", "action", "order", "camera", "visual")
WEIGHTS = {"pass": 2, "unclear": 1, "fail": 0}
MODELS = ("int8", "bf16")


def measure(rows, original="original"):
    groups = defaultdict(dict)
    for row in rows:
        try:
            case, seed, variant, model = (row[key].strip() for key in ("case", "seed", "variant", "model"))
            score = sum(WEIGHTS[row[key].strip()] for key in CHECKS)
        except (KeyError, AttributeError) as error:
            raise ValueError("Row has a missing or invalid field") from error
        if not all((case, seed, variant)) or model not in MODELS:
            raise ValueError("Every row needs a case, seed, variant and known model")
        group = groups[case, seed]
        if (variant, model) in group:
            raise ValueError(f"Duplicate result for {case}/{seed}/{variant}/{model}")
        group[variant, model] = score

    results = []
    for (case, seed), group in sorted(groups.items()):
        variants = {variant for variant, _ in group}
        if len(variants) < 2 or original not in variants or len(group) != len(variants) * len(MODELS):
            raise ValueError(f"Incomplete paired results for {case}/{seed}")
        ranked = [original, *sorted(variants - {original})]
        selected = max(ranked, key=lambda variant: group[variant, "int8"])
        bf16_original = group[original, "bf16"]
        bf16_selected = group[selected, "bf16"]
        results.append({"case":case, "seed":seed, "selected":selected, "bf16_original":bf16_original,
                        "bf16_selected":bf16_selected,
                        "bf16_best":max(group[variant, "bf16"] for variant in variants)})
    if not results:
        raise ValueError("No complete paired results")
    full_score = 2 * len(CHECKS)
    base = sum(item["bf16_original"] == full_score for item in results)
    chosen = sum(item["bf16_selected"] == full_score for item in results)
    n = len(results)
    return {"shot_seed_pairs":n, "bf16_original_pass_rate":base/n, "bf16_selected_pass_rate":chosen/n,
            "improvement_percentage_points":round(100*(chosen-base)/n, 2),
            "selected_among_best_bf16":sum(item["bf16_selected"] == item["bf16_best"] for item in results)/n,
            "results":results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", type=Path)
    parser.add_argument("--original", default="original")
    args = parser.parse_args()
    try:
        with args.csv.open(encoding="utf-8-sig", newline="") as handle:
            report = measure(csv.DictReader(handle), args.original)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
