// Offline CS practice questions, used when the AI isn't available. Each one is tagged with keywords
// so it matches lecture topics like "Recursion II" or "Lists & Algorithm Analysis".
export const CS_BANK = [
  { keys: ['recursion'], q: 'What does f(4) return?', code: 'int f(int n) {\n  if (n <= 1) return 1;\n  return n * f(n - 1);\n}', o: ['4', '10', '24', '120'], a: 2, x: '4 × 3 × 2 × 1 = 24. The base case returns 1 when n is 1.' },
  { keys: ['recursion'], q: 'What does g(6) return?', code: 'int g(int n) {\n  if (n == 0) return 0;\n  return n + g(n - 2);\n}', o: ['12', '21', '6', 'It never stops'], a: 0, x: '6 + 4 + 2 + 0 = 12. (g(5) would skip past 0 and never stop.)' },
  { keys: ['stack'], q: 'What does this print?', code: 'Stack<Integer> s = new Stack<>();\ns.push(1); s.push(2); s.push(3);\ns.pop();\ns.push(4);\nSystem.out.println(s.peek());', o: ['1', '2', '3', '4'], a: 3, x: 'pop() removes 3, then 4 goes on top, so peek() sees 4.' },
  { keys: ['queue'], q: 'What does this print?', code: 'Queue<Integer> q = new LinkedList<>();\nq.add(1); q.add(2); q.add(3);\nq.remove();\nSystem.out.println(q.peek());', o: ['1', '2', '3', 'null'], a: 1, x: 'A queue is first in, first out: remove() takes 1, so 2 is at the front.' },
  { keys: ['analysis', 'big-o', 'complexity', 'runtime', 'efficiency'], q: 'What is the running time of this loop?', code: 'for (int i = 0; i < n; i++)\n  for (int j = i; j < n; j++)\n    count++;', o: ['O(n)', 'O(n log n)', 'O(n²)', 'O(2ⁿ)'], a: 2, x: 'The inner loop runs n + (n−1) + … + 1 ≈ n²/2 times, which is O(n²).' },
  { keys: ['analysis', 'big-o', 'complexity', 'search', 'runtime'], q: 'What is the running time of this loop?', code: 'int i = n;\nwhile (i > 1) {\n  i = i / 2;\n}', o: ['O(1)', 'O(log n)', 'O(n)', 'O(n²)'], a: 1, x: 'i halves each time, so it takes about log₂ n steps.' },
  { keys: ['linked', 'node', 'list'], q: 'What does this print?', code: 'Node a = new Node(1);\na.next = new Node(2);\na.next.next = new Node(3);\na = a.next;\nSystem.out.println(a.data);', o: ['1', '2', '3', 'null'], a: 1, x: 'a moves forward one node, to the node holding 2.' },
  { keys: ['linked', 'node', 'bag', 'list'], q: 'What\'s the bug in this method?', code: 'int count(Node head) {\n  int c = 0;\n  Node cur = head;\n  while (cur != null) {\n    c++;\n  }\n  return c;\n}', o: ['cur never moves forward, so it loops forever', 'c should start at 1', 'head can\'t be null', 'It counts one node too many'], a: 0, x: 'It needs cur = cur.next; inside the loop, or cur is never null.' },
  { keys: ['search', 'analysis', 'binary'], q: 'Binary search on 1,000,000 sorted items needs at most about how many comparisons?', code: null, o: ['20', '1,000', '500,000', '1,000,000'], a: 0, x: 'It halves the range each step, and 2²⁰ is about a million.' },
  { keys: ['sort'], q: 'How long does selection sort take on an array that\'s already sorted?', code: null, o: ['O(n)', 'O(n log n)', 'O(n²)', 'O(log n)'], a: 2, x: 'Selection sort always scans the rest of the array for the minimum, sorted or not.' },
  { keys: ['sort', 'merge'], q: 'What is merge sort\'s running time?', code: null, o: ['O(n)', 'O(n log n)', 'O(n²)', 'O(log n)'], a: 1, x: 'It splits about log n times and merges n items at each level.' },
  { keys: ['hash', 'dictionar', 'map'], q: 'Keys 12, 22, and 32 go into a table of size 10 with hash(key) = key % 10. What happens?', code: null, o: ['All three collide at index 2', 'They go to 1, 2, and 3', 'They go to 12, 22, and 32', 'Only 12 fits'], a: 0, x: 'Each key % 10 is 2, so they all hash to the same slot.' },
  { keys: ['iterat'], q: 'What does this print?', code: 'List<Integer> list = new ArrayList<>(List.of(1, 2, 3));\nIterator<Integer> it = list.iterator();\nit.next();\nit.next();\nSystem.out.println(it.hasNext());', o: ['true', 'false', '2', 'It throws an exception'], a: 0, x: 'Two of the three items have been visited, so one is left.' },
  { keys: ['abstract', 'adt', 'interface'], q: 'Which one is an abstract data type, not an implementation?', code: null, o: ['List', 'ArrayList', 'int[]', 'A Node class'], a: 0, x: 'List describes what operations exist. ArrayList is one way to build it.' },
  { keys: ['java'], q: 'What does this print?', code: 'String a = new String("hi");\nString b = new String("hi");\nSystem.out.println(a == b);', o: ['true', 'false', 'hi', 'It doesn\'t compile'], a: 1, x: '== compares references. These are two different objects, so use equals().' },
  { keys: ['string', 'match'], q: 'Brute-force search for a length-m pattern in a length-n text takes how long in the worst case?', code: null, o: ['O(n)', 'O(m)', 'O(n·m)', 'O(log n)'], a: 2, x: 'It can compare up to m characters at each of about n starting spots.' }
];

// Picks up to 3 questions matching the topics, one per topic when possible.
export function csQuiz(topics) {
  const list = topics.length ? topics : ['analysis'];
  const used = new Set(), out = [];
  const match = t => CS_BANK.map((q, i) => ({ q, i })).filter(({ q, i }) => !used.has(i) && q.keys.some(k => t.toLowerCase().includes(k)));
  for (let round = 0; round < 3 && out.length < 3; round++) {
    for (const t of list) {
      if (out.length >= 3) break;
      const m = match(t); if (!m.length) continue;
      const pick = m[(round + out.length) % m.length];
      used.add(pick.i); out.push({ topic: t, q: pick.q.q, code: pick.q.code, options: pick.q.o, answer: pick.q.a, explain: pick.q.x });
    }
  }
  // Top up to 3 with general analysis questions every CS student should know.
  for (const [i, q] of CS_BANK.entries()) {
    if (out.length >= 3 || !out.length) break;
    if (used.has(i) || !q.keys.some(k => ['analysis', 'big-o', 'search'].includes(k))) continue;
    used.add(i); out.push({ topic: list[0], q: q.q, code: q.code, options: q.o, answer: q.a, explain: q.x });
  }
  return out.length ? out : null;
}

// A longer offline practice set: every question that matches the topics first, then general ones, no repeats.
export function csPractice(topics, n = 10) {
  const list = topics.length ? topics : ['analysis'];
  const seen = new Set(), out = [];
  const add = (i, topic) => { if (seen.has(i) || out.length >= n) return; seen.add(i); const q = CS_BANK[i]; out.push({ topic, type: 'mc', q: q.q, code: q.code, options: q.o, answer: q.a, explain: q.x }); };
  // round-robin across topics so each one is covered
  const pools = list.map(t => ({ t, ids: CS_BANK.map((q, i) => i).filter(i => CS_BANK[i].keys.some(k => t.toLowerCase().includes(k))) }));
  for (let r = 0; out.length < n && pools.some(p => p.ids.length > r); r++) for (const p of pools) if (p.ids[r] != null) add(p.ids[r], p.t);
  for (const [i, q] of CS_BANK.entries()) if (q.keys.some(k => ['analysis', 'big-o', 'search'].includes(k))) add(i, list[0]);
  return out;
}

// Free-response practice problems with model answers, for when the AI isn't available.
export const CS_WRITE = [
  { keys: ['recursion'], q: 'Write a recursive method sum(int n) that returns 1 + 2 + … + n.', model: 'int sum(int n) {\n  if (n <= 0) return 0;      // base case\n  return n + sum(n - 1);    // smaller problem\n}' },
  { keys: ['recursion', 'string'], q: 'Write a recursive method reverse(String s) that returns s backwards.', model: 'String reverse(String s) {\n  if (s.length() <= 1) return s;\n  return reverse(s.substring(1)) + s.charAt(0);\n}' },
  { keys: ['stack'], q: 'Using a Stack<Character>, write isBalanced(String s) that returns true if every ( has a matching ).', model: 'boolean isBalanced(String s) {\n  Stack<Character> st = new Stack<>();\n  for (char c : s.toCharArray()) {\n    if (c == \'(\') st.push(c);\n    else if (c == \')\') {\n      if (st.isEmpty()) return false;\n      st.pop();\n    }\n  }\n  return st.isEmpty();\n}' },
  { keys: ['linked', 'node', 'bag', 'list'], q: 'Write addFirst(int x) for a singly linked list with a head reference.', model: 'void addFirst(int x) {\n  Node n = new Node(x);\n  n.next = head;\n  head = n;\n}' },
  { keys: ['queue'], q: 'Explain how to build a queue with two stacks, and the cost of each operation.', model: 'Push new items onto stack A. To dequeue, if stack B is empty, pop everything from A onto B, then pop B. Each item moves at most once, so enqueue and dequeue are O(1) amortized.' },
  { keys: ['sort'], q: 'Explain why merge sort is O(n log n).', model: 'The array is halved about log n times, and each level of merging touches all n items once, so the total work is n × log n.' },
  { keys: ['analysis', 'big-o', 'search'], q: 'Write binary search for a sorted int array. Return the index or -1.', model: 'int find(int[] a, int x) {\n  int lo = 0, hi = a.length - 1;\n  while (lo <= hi) {\n    int mid = (lo + hi) / 2;\n    if (a[mid] == x) return mid;\n    if (a[mid] < x) lo = mid + 1; else hi = mid - 1;\n  }\n  return -1;\n}' },
  { keys: ['hash', 'dictionar', 'map'], q: 'Describe two ways a hash table can handle collisions.', model: 'Separate chaining stores a list at each slot and appends colliding keys. Open addressing probes for another empty slot, for example with linear probing (try the next index).' }
];
export function csWrite(topics, n = 2) {
  const out = [], used = new Set();
  for (const t of topics.length ? topics : ['analysis']) for (const [i, w] of CS_WRITE.entries()) {
    if (out.length >= n) break;
    if (!used.has(i) && w.keys.some(k => t.toLowerCase().includes(k))) { used.add(i); out.push({ topic: t, type: 'short', q: w.q, code: null, model: w.model, explain: 'Compare your answer to this model solution.' }); }
  }
  return out;
}
