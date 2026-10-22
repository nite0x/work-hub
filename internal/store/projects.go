package store

import "worktree-hub/internal/model"

func (s *Store) ProjectMap() (map[string]model.Project, error) {
	ps, err := s.Projects()
	if err != nil {
		return nil, err
	}
	out := map[string]model.Project{}
	for _, p := range ps {
		out[p.ID] = p
	}
	return out, nil
}
