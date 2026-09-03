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
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      activity_events: {
        Row: {
          actor: string
          capability_id: string
          created_at: string
          detail: string | null
          finished_at: string | null
          id: string
          service: string
          status: string
          title: string
          user_id: string
        }
        Insert: {
          actor?: string
          capability_id: string
          created_at?: string
          detail?: string | null
          finished_at?: string | null
          id?: string
          service: string
          status?: string
          title: string
          user_id: string
        }
        Update: {
          actor?: string
          capability_id?: string
          created_at?: string
          detail?: string | null
          finished_at?: string | null
          id?: string
          service?: string
          status?: string
          title?: string
          user_id?: string
        }
        Relationships: []
      }
      browserbase_contexts: {
        Row: {
          context_id: string
          created_at: string
          purpose: string
          updated_at: string
          user_id: string
        }
        Insert: {
          context_id: string
          created_at?: string
          purpose: string
          updated_at?: string
          user_id: string
        }
        Update: {
          context_id?: string
          created_at?: string
          purpose?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      generation_jobs: {
        Row: {
          actor: string
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          kind: string
          model: string
          operation_name: string | null
          parameters: Json
          prompt: string
          provider: string
          result: Json | null
          status: string
          status_detail: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          actor?: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          kind: string
          model: string
          operation_name?: string | null
          parameters?: Json
          prompt: string
          provider: string
          result?: Json | null
          status?: string
          status_detail?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          actor?: string
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          kind?: string
          model?: string
          operation_name?: string | null
          parameters?: Json
          prompt?: string
          provider?: string
          result?: Json | null
          status?: string
          status_detail?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      google_connections: {
        Row: {
          access_token_ciphertext: string | null
          access_token_expires_at: string | null
          created_at: string
          google_email: string | null
          google_sub: string | null
          granted_scopes: string[]
          id: string
          last_error: string | null
          refresh_token_ciphertext: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          access_token_ciphertext?: string | null
          access_token_expires_at?: string | null
          created_at?: string
          google_email?: string | null
          google_sub?: string | null
          granted_scopes?: string[]
          id?: string
          last_error?: string | null
          refresh_token_ciphertext?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          access_token_ciphertext?: string | null
          access_token_expires_at?: string | null
          created_at?: string
          google_email?: string | null
          google_sub?: string | null
          granted_scopes?: string[]
          id?: string
          last_error?: string | null
          refresh_token_ciphertext?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      nexus_notebook_sources: {
        Row: {
          cached_text: string | null
          char_count: number
          created_at: string
          id: string
          kind: string
          notebook_id: string
          reference: string | null
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          cached_text?: string | null
          char_count?: number
          created_at?: string
          id?: string
          kind: string
          notebook_id: string
          reference?: string | null
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          cached_text?: string | null
          char_count?: number
          created_at?: string
          id?: string
          kind?: string
          notebook_id?: string
          reference?: string | null
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "nexus_notebook_sources_notebook_id_fkey"
            columns: ["notebook_id"]
            isOneToOne: false
            referencedRelation: "nexus_notebooks"
            referencedColumns: ["id"]
          },
        ]
      }
      nexus_notebooks: {
        Row: {
          created_at: string
          description: string | null
          drive_folder_id: string | null
          id: string
          title: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          drive_folder_id?: string | null
          id?: string
          title: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          description?: string | null
          drive_folder_id?: string | null
          id?: string
          title?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      notebooklm_connections: {
        Row: {
          connected_at: string
          disconnected_at: string | null
          last_used_at: string | null
          status: string
          user_id: string
          vault_secret_name: string
        }
        Insert: {
          connected_at?: string
          disconnected_at?: string | null
          last_used_at?: string | null
          status?: string
          user_id: string
          vault_secret_name: string
        }
        Update: {
          connected_at?: string
          disconnected_at?: string | null
          last_used_at?: string | null
          status?: string
          user_id?: string
          vault_secret_name?: string
        }
        Relationships: []
      }
      oauth_states: {
        Row: {
          code_verifier: string
          created_at: string
          redirect_to: string | null
          state: string
          user_id: string
        }
        Insert: {
          code_verifier: string
          created_at?: string
          redirect_to?: string | null
          state: string
          user_id: string
        }
        Update: {
          code_verifier?: string
          created_at?: string
          redirect_to?: string | null
          state?: string
          user_id?: string
        }
        Relationships: []
      }
      operation_logs: {
        Row: {
          actor: string
          capability: string
          created_at: string
          details: Json
          duration_ms: number | null
          error_message: string | null
          id: string
          implementation: string
          service: string
          success: boolean
          user_id: string
        }
        Insert: {
          actor?: string
          capability: string
          created_at?: string
          details?: Json
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          implementation: string
          service: string
          success: boolean
          user_id: string
        }
        Update: {
          actor?: string
          capability?: string
          created_at?: string
          details?: Json
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          implementation?: string
          service?: string
          success?: boolean
          user_id?: string
        }
        Relationships: []
      }
      service_health: {
        Row: {
          checked_at: string
          detail: string | null
          id: string
          service: string
          status: string
          user_id: string
        }
        Insert: {
          checked_at?: string
          detail?: string | null
          id?: string
          service: string
          status: string
          user_id: string
        }
        Update: {
          checked_at?: string
          detail?: string | null
          id?: string
          service?: string
          status?: string
          user_id?: string
        }
        Relationships: []
      }
      steel_live_sessions: {
        Row: {
          created_at: string
          current_url: string | null
          id: string
          last_used_at: string
          steel_session_id: string
          user_id: string
          websocket_url: string
        }
        Insert: {
          created_at?: string
          current_url?: string | null
          id?: string
          last_used_at?: string
          steel_session_id: string
          user_id: string
          websocket_url: string
        }
        Update: {
          created_at?: string
          current_url?: string | null
          id?: string
          last_used_at?: string
          steel_session_id?: string
          user_id?: string
          websocket_url?: string
        }
        Relationships: []
      }
      workflow_runs: {
        Row: {
          created_at: string
          error_message: string | null
          id: string
          name: string
          result: Json | null
          status: string
          steps: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          error_message?: string | null
          id?: string
          name: string
          result?: Json | null
          status?: string
          steps?: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          error_message?: string | null
          id?: string
          name?: string
          result?: Json | null
          status?: string
          steps?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      vault_create_secret: {
        Args: {
          secret_description?: string
          secret_name: string
          secret_value: string
        }
        Returns: string
      }
      vault_delete_secret_by_name: {
        Args: { secret_name: string }
        Returns: undefined
      }
      vault_read_secret_by_name: {
        Args: { secret_name: string }
        Returns: string
      }
    }
    Enums: {
      [_ in never]: never
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
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
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
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
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
