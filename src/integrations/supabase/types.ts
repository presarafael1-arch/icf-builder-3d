export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      bom_results: {
        Row: {
          calculated_at: string
          cuts_count: number
          cuts_length_mm: number
          id: string
          panels_count: number
          project_id: string
          tarugos_adjustments: number
          tarugos_base: number
          tarugos_injection: number
          tarugos_total: number
          topos_meters: number
          topos_units: number
          webs_per_row: number
          webs_total: number
        }
        Insert: {
          calculated_at?: string
          cuts_count?: number
          cuts_length_mm?: number
          id?: string
          panels_count?: number
          project_id: string
          tarugos_adjustments?: number
          tarugos_base?: number
          tarugos_injection?: number
          tarugos_total?: number
          topos_meters?: number
          topos_units?: number
          webs_per_row?: number
          webs_total?: number
        }
        Update: {
          calculated_at?: string
          cuts_count?: number
          cuts_length_mm?: number
          id?: string
          panels_count?: number
          project_id?: string
          tarugos_adjustments?: number
          tarugos_base?: number
          tarugos_injection?: number
          tarugos_total?: number
          topos_meters?: number
          topos_units?: number
          webs_per_row?: number
          webs_total?: number
        }
        Relationships: [
          {
            foreignKeyName: "bom_results_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: true
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      openings: {
        Row: {
          created_at: string
          height_mm: number
          id: string
          opening_type: string
          position_mm: number
          sill_height_mm: number | null
          wall_id: string
          width_mm: number
        }
        Insert: {
          created_at?: string
          height_mm: number
          id?: string
          opening_type: string
          position_mm: number
          sill_height_mm?: number | null
          wall_id: string
          width_mm: number
        }
        Update: {
          created_at?: string
          height_mm?: number
          id?: string
          opening_type?: string
          position_mm?: number
          sill_height_mm?: number | null
          wall_id?: string
          width_mm?: number
        }
        Relationships: [
          {
            foreignKeyName: "openings_wall_id_fkey"
            columns: ["wall_id"]
            isOneToOne: false
            referencedRelation: "walls"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          concrete_thickness: Database["public"]["Enums"]["concrete_thickness"]
          corner_mode: Database["public"]["Enums"]["corner_mode"]
          created_at: string
          description: string | null
          dxf_file_url: string | null
          id: string
          name: string
          rebar_spacing_cm: number
          updated_at: string
          wall_height_mm: number
        }
        Insert: {
          concrete_thickness?: Database["public"]["Enums"]["concrete_thickness"]
          corner_mode?: Database["public"]["Enums"]["corner_mode"]
          created_at?: string
          description?: string | null
          dxf_file_url?: string | null
          id?: string
          name: string
          rebar_spacing_cm?: number
          updated_at?: string
          wall_height_mm?: number
        }
        Update: {
          concrete_thickness?: Database["public"]["Enums"]["concrete_thickness"]
          corner_mode?: Database["public"]["Enums"]["corner_mode"]
          created_at?: string
          description?: string | null
          dxf_file_url?: string | null
          id?: string
          name?: string
          rebar_spacing_cm?: number
          updated_at?: string
          wall_height_mm?: number
        }
        Relationships: []
      }
      uploads: {
        Row: {
          file_type: string
          filename: string
          id: string
          project_id: string
          selected_layers: string[] | null
          storage_path: string
          uploaded_at: string
        }
        Insert: {
          file_type?: string
          filename: string
          id?: string
          project_id: string
          selected_layers?: string[] | null
          storage_path: string
          uploaded_at?: string
        }
        Update: {
          file_type?: string
          filename?: string
          id?: string
          project_id?: string
          selected_layers?: string[] | null
          storage_path?: string
          uploaded_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "uploads_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      walls: {
        Row: {
          created_at: string
          end_x: number
          end_y: number
          id: string
          layer_name: string | null
          project_id: string
          start_x: number
          start_y: number
        }
        Insert: {
          created_at?: string
          end_x: number
          end_y: number
          id?: string
          layer_name?: string | null
          project_id: string
          start_x: number
          start_y: number
        }
        Update: {
          created_at?: string
          end_x?: number
          end_y?: number
          id?: string
          layer_name?: string | null
          project_id?: string
          start_x?: number
          start_y?: number
        }
        Relationships: [
          {
            foreignKeyName: "walls_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      [_ in never]: never
    }
    Enums: {
      concrete_thickness: "150" | "200"
      corner_mode: "overlap_cut" | "topo"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      concrete_thickness: ["150", "200"],
      corner_mode: ["overlap_cut", "topo"],
    },
  },
} as const
