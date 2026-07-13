# Candidate recall
- Folds: 635, queries: 25752
- Avg candidates/member: 951.8

| segment | R@100 | R@200 | R@500 | R@1000 |
|---|---|---|---|---|
| all | 0.566 | 0.650 | 0.753 | 0.805 |
| novel | 0.141 | 0.245 | 0.438 | 0.552 |
| repeat | 0.906 | 0.968 | 0.996 | 1.000 |

**Gate**: recall@1000 ≥ 0.8 → overall 0.805 = **PASS**
(novel-ticker recall@1000 = 0.552)