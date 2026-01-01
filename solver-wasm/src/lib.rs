use wasm_bindgen::prelude::*;
use std::collections::{HashMap, HashSet, VecDeque};
use std::cmp::Ordering;

#[derive(Clone, Eq, PartialEq)]
struct State {
    colors: Vec<u8>,
    steps: Vec<u8>,
    cost: usize, // g + h
}

impl Ord for State {
    fn cmp(&self, other: &Self) -> Ordering {
        // Reverse for min-heap
        other.cost.cmp(&self.cost)
    }
}

impl PartialOrd for State {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

#[wasm_bindgen]
pub struct Solver {
    adj: Vec<Vec<usize>>,
    initial_colors: Vec<u8>,
    palette: Vec<u8>,
    color_map: HashMap<String, u8>,
    rev_color_map: HashMap<u8, String>,
}

#[wasm_bindgen]
impl Solver {
    #[wasm_bindgen(constructor)]
    pub fn new(num_nodes: usize, palette_strs: JsValue) -> Solver {
        let p_strs: Vec<String> = serde_wasm_bindgen::from_value(palette_strs).unwrap();
        let mut color_map = HashMap::new();
        let mut rev_color_map = HashMap::new();
        let mut palette = Vec::new();
        
        for (i, s) in p_strs.iter().enumerate() {
            let code = (i + 1) as u8;
            color_map.insert(s.clone(), code);
            rev_color_map.insert(code, s.clone());
            palette.push(code);
        }

        Solver {
            adj: vec![vec![]; num_nodes],
            initial_colors: vec![0; num_nodes],
            palette,
            color_map,
            rev_color_map,
        }
    }

    pub fn set_node(&mut self, id: usize, color: &str, neighbors: &[usize]) {
        if id >= self.adj.len() { return; }
        if let Some(&c) = self.color_map.get(color) {
            self.initial_colors[id] = c;
        }
        self.adj[id] = neighbors.to_vec();
    }

    pub fn solve(&self, start_id: usize, max_depth: usize) -> JsValue {
        let start_color = self.initial_colors[start_id];
        if start_color == 0 { return JsValue::NULL; }

        // Initial Region
        let mut initial_region = vec![false; self.adj.len()];
        let mut q = VecDeque::new();
        q.push_back(start_id);
        let mut region_indices = Vec::new();
        
        // BFS to find initial region
        let mut v_local = vec![false; self.adj.len()];
        v_local[start_id] = true;
        
        while let Some(u) = q.pop_front() {
            if self.initial_colors[u] != start_color { continue; }
            initial_region[u] = true;
            region_indices.push(u);
            
            for &v in &self.adj[u] {
                if !v_local[v] && self.initial_colors[v] == start_color {
                    v_local[v] = true;
                    q.push_back(v);
                }
            }
        }

        // Search State
        // For simplicity, using a naive BFS for this demo
        // In production, this should match the sophisticated A* in JS
        
        let mut queue = VecDeque::new();
        queue.push_back((self.initial_colors.clone(), region_indices.clone(), Vec::<u8>::new()));
        
        let mut seen: HashSet<Vec<u8>> = HashSet::new();
        seen.insert(self.initial_colors.clone());

        let mut nodes_explored = 0;

        while let Some((curr_colors, curr_region, steps)) = queue.pop_front() {
            nodes_explored += 1;
            if steps.len() >= max_depth { continue; }
            if nodes_explored > 5000 { break; } // Safety break

            // Check if uniform
            let first = curr_colors.iter().find(|&&c| c != 0); // Skip '0' (transparent/deleted)
            let mut uniform = true;
            if let Some(&f) = first {
                for &c in &curr_colors {
                    if c != 0 && c != f {
                        uniform = false;
                        break;
                    }
                }
            }
            
            if uniform {
                // Found solution!
                let result_strs: Vec<String> = steps.iter()
                    .map(|&c| self.rev_color_map.get(&c).unwrap().clone())
                    .collect();
                return serde_wasm_bindgen::to_value(&result_strs).unwrap();
            }

            // Find adjacent colors
            let mut adj_colors = HashSet::new();
            for &u in &curr_region {
                for &v in &self.adj[u] {
                    let c = curr_colors[v];
                    let rc = curr_colors[curr_region[0]]; // Current region color
                    if c != 0 && c != rc {
                        adj_colors.insert(c);
                    }
                }
            }

            if adj_colors.is_empty() { continue; }

            // Try each color
            for &next_c in &adj_colors {
                let mut next_colors = curr_colors.clone();
                let mut next_region = curr_region.clone();
                
                // Update colors in region
                for &idx in &curr_region {
                    next_colors[idx] = next_c;
                }

                // Expand region
                let mut expansion_q = VecDeque::new();
                for &idx in &curr_region {
                    expansion_q.push_back(idx);
                }
                
                // We need a better way to track visited for expansion to avoid re-scanning known region
                // But for now, simple BFS expansion
                let mut local_visited = vec![false; self.adj.len()];
                for &idx in &curr_region { local_visited[idx] = true; }
                
                let mut head = 0;
                while head < next_region.len() {
                    let u = next_region[head];
                    head += 1;
                    
                    for &v in &self.adj[u] {
                        if !local_visited[v] && next_colors[v] == next_c {
                            local_visited[v] = true;
                            next_region.push(v);
                        }
                    }
                }

                // Hash check (Simplified string hash for demo, should utilize Zobrist)
                // In full version, implement Zobrist here
                let mut key = Vec::with_capacity(self.adj.len());
                key.extend_from_slice(&next_colors);
                // Simple vector hashing is not efficient for map keys in Rust without good hasher
                // Using a truncated string for seen check
                
                // ... (Skip complex hashing for this demo, just push to queue)
                
                let mut next_steps = steps.clone();
                next_steps.push(next_c);
                
                if !seen.contains(&next_colors) {
                    seen.insert(next_colors.clone());
                    queue.push_back((next_colors, next_region, next_steps));
                }
            }
        }

        JsValue::NULL
    }
}
